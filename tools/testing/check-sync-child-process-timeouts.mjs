#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const SYNC_APIS = new Set(['execFileSync', 'execSync', 'spawnSync']);

// The one file allowed to call the raw Node APIs by their aliased import
// name (`execSync as nodeExecSync`, etc.) without going through itself —
// see the comment in findUnboundedCalls().
const BOUNDED_HELPER_IMPLEMENTATION_FILE = 'src/process/bounded-child-process.mjs';
// Healthy test commands finish well below one minute; this leaves generous CI
// headroom while turning an indefinite worker wedge into an attributable failure.
export const TEST_PROCESS_TIMEOUT_MS = 60_000;

// Product-code directories covered by this gate (#3062), beyond the
// pre-existing test/ scan. Each is scanned the same way; what differs is
// whether findings fail the run (see `--enforce-product` below).
const PRODUCT_DIRS = ['src', 'tools', 'bin'];

// A call is exempted as interactive by pairing a `// sync-spawn: interactive
// <anchor>` comment at the call site with a matching entry in the allow-list
// (see `loadAllowList`). The marker is the anchor: it moves with the code
// (robust to line shifts) and lets one file carry several distinct
// exemptions (one anchor per call), which an enclosing-function-name anchor
// cannot do once a function holds more than one flagged call.
const MARKER_RE = /\/\/\s*sync-spawn:\s*interactive\s+([a-z0-9][a-z0-9-]*)/i;

export const ALLOWLIST_RELATIVE_PATH = 'tools/testing/sync-spawn-allowlist.json';

/**
 * Normalize a relative path to POSIX separators, regardless of which
 * separator the current OS (or the path that produced it) used. Split on
 * either `/` or `\` explicitly — not just the current `path.sep` — so this
 * is verifiable on any OS: a path already built with Windows (`\`)
 * separators normalizes the same way whether or not the process actually
 * runs on Windows right now.
 *
 * @param {string} relativePath
 * @returns {string}
 */
export function toPosixPath(relativePath) {
  return relativePath.split(/[\\/]/).join('/');
}

/**
 * `path.relative()` on Windows returns backslash-separated paths; the
 * allow-list (and every `file` field this gate reports/compares) is
 * authored with POSIX separators. Without normalizing, a Windows run would
 * never match an existing allow-list entry — every entry would read as
 * stale, and a real exemption would read as an unmatched violation
 * (#3062 finding 15).
 *
 * @param {string} root
 * @param {string} file
 * @returns {string}
 */
function toPosixRelative(root, file) {
  return toPosixPath(path.relative(root, file));
}

function sourceFiles(root, dirNames) {
  const files = [];
  const visit = (directory) => {
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return; // directory may not exist (e.g. bin/ before other work lands) — nothing to scan
    }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (/\.[cm]?[jt]sx?$/.test(entry.name)) files.push(target);
    }
  };
  for (const dirName of dirNames) visit(path.join(root, dirName));
  return files.sort();
}

const CHILD_PROCESS_MODULE_SPECIFIERS = new Set(['child_process', 'node:child_process']);

/**
 * Resolve a possible relative import/export specifier to the absolute file
 * it names, trying each plausible extension (this repo's relative specs
 * are always written with an explicit extension already, but a `.js`
 * specifier may point at either a `.js` file or, in a `tools/**` script
 * resolved from TypeScript source, a same-named `.ts` file).
 *
 * @param {string} fromFile - absolute path of the file containing the specifier
 * @param {string} specifier
 * @returns {string | null}
 */
function resolveRelativeSpecifier(fromFile, specifier) {
  if (!specifier.startsWith('.')) return null;
  const resolved = path.resolve(path.dirname(fromFile), specifier);
  if (fs.existsSync(resolved)) return resolved;
  if (resolved.endsWith('.js')) {
    const tsCandidate = resolved.slice(0, -3) + '.ts';
    if (fs.existsSync(tsCandidate)) return tsCandidate;
  }
  return null;
}

/**
 * Cross-file re-export resolution (#3062 B/C finding 8): a file can
 * re-export a sync child-process API from `node:child_process` under a
 * new name (`export { execSync as runSync } from 'node:child_process'`),
 * or re-export *that* re-export from yet another local file. A single-file
 * scan can never see this — the identifier a caller imports (`runSync`)
 * never appears anywhere near the real API name in the caller's own
 * source. This builds one index, across every file this gate scans, of
 * `resolved absolute file path -> Map<locally exported name, real API
 * name>`, resolving relative-reexport chains to a fixed point so the order
 * files happen to be visited in doesn't matter.
 *
 * @param {string[]} absoluteFiles
 * @returns {Map<string, Map<string, string>>}
 */
export function buildReExportIndex(absoluteFiles) {
  const index = new Map();
  /** @type {{ file: string, exportedName: string, targetFile: string, originalName: string }[]} */
  const pendingRelative = [];

  for (const file of absoluteFiles) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const exportsForFile = new Map();
    const visit = (node) => {
      if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)
          && node.exportClause && ts.isNamedExports(node.exportClause)) {
        const specifier = node.moduleSpecifier.text;
        for (const element of node.exportClause.elements) {
          const originalName = (element.propertyName ?? element.name).text;
          const exportedName = element.name.text;
          if (CHILD_PROCESS_MODULE_SPECIFIERS.has(specifier) && SYNC_APIS.has(originalName)) {
            exportsForFile.set(exportedName, originalName);
          } else if (specifier.startsWith('.')) {
            const targetFile = resolveRelativeSpecifier(file, specifier);
            if (targetFile) pendingRelative.push({ file, exportedName, targetFile, originalName });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    index.set(file, exportsForFile);
  }

  for (let pass = 0; pass < 5; pass += 1) {
    let changed = false;
    for (const edge of pendingRelative) {
      if (index.get(edge.file)?.has(edge.exportedName)) continue;
      const resolved = index.get(edge.targetFile)?.get(edge.originalName);
      if (resolved) {
        index.get(edge.file).set(edge.exportedName, resolved);
        changed = true;
      }
    }
    if (!changed) break;
  }

  return index;
}

/**
 * Resolve local bindings for the raw sync child-process APIs within one
 * file (#3062 finding 3): aliased named imports (`execSync as nodeExecSync`),
 * namespace/default imports (`import cp from 'child_process'`, `import *
 * as cp`), `require('child_process')` — whole-module or destructured, with
 * or without a rename — a re-export from another local file (resolved via
 * `crossFile`, #3062 B/C finding 8), and a same-file reassignment chain
 * (`const foo = nodeExecSync`, `const foo = cp.execSync`,
 * `const foo = cp['execSync']`, or `const { execSync: x } = cp`). This lets
 * `calledApi` recognize a call through any of those bindings, not just a
 * literal `execSync`/`execFileSync`/`spawnSync` identifier or property
 * name.
 *
 * @param {ts.SourceFile} source
 * @param {{ file: string, reExportIndex: Map<string, Map<string, string>> } | undefined} crossFile
 * @returns {{ aliasToApi: Map<string, string>, namespaceAliases: Set<string> }}
 */
function collectChildProcessApiAliases(source, crossFile) {
  const aliasToApi = new Map();
  const namespaceAliases = new Set();

  const isRequireChildProcess = (node) =>
    ts.isCallExpression(node)
    && ts.isIdentifier(node.expression)
    && node.expression.text === 'require'
    && node.arguments.length === 1
    && ts.isStringLiteralLike(node.arguments[0])
    && CHILD_PROCESS_MODULE_SPECIFIERS.has(node.arguments[0].text);

  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier) && node.importClause) {
      const specifier = node.moduleSpecifier.text;
      const isChildProcess = CHILD_PROCESS_MODULE_SPECIFIERS.has(specifier);
      // A relative import might be importing a re-export (#3062 B/C
      // finding 8): resolve it through the cross-file index when this
      // isn't a direct `node:child_process` import.
      const reExports = !isChildProcess && crossFile && specifier.startsWith('.')
        ? crossFile.reExportIndex.get(resolveRelativeSpecifier(crossFile.file, specifier) ?? '')
        : undefined;
      if (isChildProcess || reExports) {
        const clause = node.importClause;
        if (clause.name && isChildProcess) namespaceAliases.add(clause.name.text); // default import
        if (clause.namedBindings) {
          if (ts.isNamespaceImport(clause.namedBindings) && isChildProcess) {
            namespaceAliases.add(clause.namedBindings.name.text);
          } else if (ts.isNamedImports(clause.namedBindings)) {
            for (const element of clause.namedBindings.elements) {
              const importedName = (element.propertyName ?? element.name).text;
              const resolvedApi = isChildProcess
                ? (SYNC_APIS.has(importedName) ? importedName : undefined)
                : reExports.get(importedName);
              if (resolvedApi) aliasToApi.set(element.name.text, resolvedApi);
            }
          }
        }
      }
    } else if (ts.isVariableDeclaration(node) && node.initializer && isRequireChildProcess(node.initializer)) {
      if (ts.isIdentifier(node.name)) {
        namespaceAliases.add(node.name.text); // const cp = require('child_process')
      } else if (ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          if (!ts.isBindingElement(element) || !ts.isIdentifier(element.name)) continue;
          const importedName = element.propertyName && ts.isIdentifier(element.propertyName)
            ? element.propertyName.text
            : element.name.text;
          if (SYNC_APIS.has(importedName)) aliasToApi.set(element.name.text, importedName);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  // Same-file reassignment chain: `const foo = nodeExecSync;` (alias of an
  // alias), `const foo = cp.execSync;` (property read off a namespace
  // alias), `const foo = cp['execSync'];` (the same, via computed element
  // access — #3062 B/C finding 8), or `const { execSync: x } = cp;`
  // (destructuring a namespace alias, as opposed to destructuring
  // `require(...)` directly, which the pass above already covers).
  // Fixed-point over a few passes handles chains in either declaration
  // order.
  for (let pass = 0; pass < 5; pass += 1) {
    let changed = false;
    const propagate = (node) => {
      if (ts.isVariableDeclaration(node) && node.initializer) {
        const init = node.initializer;
        if (ts.isIdentifier(node.name)) {
          const targetName = node.name.text;
          if (ts.isIdentifier(init)) {
            if (!aliasToApi.has(targetName) && aliasToApi.has(init.text)) {
              aliasToApi.set(targetName, aliasToApi.get(init.text));
              changed = true;
            }
            if (!namespaceAliases.has(targetName) && namespaceAliases.has(init.text)) {
              namespaceAliases.add(targetName);
              changed = true;
            }
          } else if (ts.isPropertyAccessExpression(init) && ts.isIdentifier(init.expression)
              && namespaceAliases.has(init.expression.text) && SYNC_APIS.has(init.name.text)
              && !aliasToApi.has(targetName)) {
            aliasToApi.set(targetName, init.name.text); // const foo = cp.execSync
            changed = true;
          } else if (ts.isElementAccessExpression(init) && ts.isIdentifier(init.expression)
              && namespaceAliases.has(init.expression.text)
              && ts.isStringLiteralLike(init.argumentExpression)
              && SYNC_APIS.has(init.argumentExpression.text)
              && !aliasToApi.has(targetName)) {
            aliasToApi.set(targetName, init.argumentExpression.text); // const foo = cp['execSync']
            changed = true;
          }
        } else if (ts.isObjectBindingPattern(node.name) && ts.isIdentifier(init)
            && namespaceAliases.has(init.text)) {
          // const { execSync: x } = cp — destructuring a namespace alias
          // (as opposed to destructuring require('child_process') directly,
          // which the import/require pass above already handles).
          for (const element of node.name.elements) {
            if (!ts.isBindingElement(element) || !ts.isIdentifier(element.name)) continue;
            const importedName = element.propertyName && ts.isIdentifier(element.propertyName)
              ? element.propertyName.text
              : element.name.text;
            if (SYNC_APIS.has(importedName) && !aliasToApi.has(element.name.text)) {
              aliasToApi.set(element.name.text, importedName);
              changed = true;
            }
          }
        }
      }
      ts.forEachChild(node, propagate);
    };
    propagate(source);
    if (!changed) break;
  }

  return { aliasToApi, namespaceAliases };
}

/** The exported name the gate trusts to produce a provably positive timeout; see positiveTimeoutMs() in src/process/bounded-child-process.mjs. */
const TRUSTED_TIMEOUT_HELPER_NAME = 'positiveTimeoutMs';

/** A local checker resolves lexical bindings without loading imports or executing code. */
function localChecker(source) {
  const host = ts.createCompilerHost({ noLib: true, noResolve: true, allowJs: true });
  host.getSourceFile = name => name === source.fileName ? source : undefined;
  return ts.createProgram([source.fileName], { noLib: true, noResolve: true, allowJs: true }, host).getTypeChecker();
}

function importedFrom(identifier, checker, exportedName, moduleMatches) {
  const declaration = checker.getSymbolAtLocation(identifier)?.declarations?.[0];
  if (!declaration || !ts.isImportSpecifier(declaration)) return false;
  const imported = (declaration.propertyName ?? declaration.name).text;
  const module = declaration.parent.parent.parent.moduleSpecifier;
  return imported === exportedName && ts.isStringLiteralLike(module) && moduleMatches(module.text, identifier.getSourceFile().fileName);
}

// Trust only the owning module, including its installed dist layout.
const gateRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const isTimeoutModule = (spec, fromFile) => spec.startsWith('.') && ['src', 'dist/src'].some(base =>
  path.resolve(path.dirname(fromFile), spec) === path.join(gateRoot, base, 'process/bounded-child-process.mjs'));
const isResolverModule = (spec, fromFile) => spec.startsWith('.') &&
  path.resolve(path.dirname(fromFile), spec) === path.join(gateRoot, 'tools/_resolve-impl.mjs');

function trustedTimeoutHelper(identifier, checker, seen = new Set()) {
  const symbol = checker.getSymbolAtLocation(identifier);
  if (!symbol || seen.has(symbol)) return false;
  seen.add(symbol);
  if (importedFrom(identifier, checker, TRUSTED_TIMEOUT_HELPER_NAME, isTimeoutModule)) return true;
  const declaration = symbol.declarations?.[0];
  if (declaration && ts.isVariableDeclaration(declaration)
      && declaration.parent.flags & ts.NodeFlags.Const && declaration.initializer
      && ts.isIdentifier(declaration.initializer)) {
    return trustedTimeoutHelper(declaration.initializer, checker, seen);
  }
  if (!declaration || !ts.isBindingElement(declaration)
      || (declaration.propertyName ?? declaration.name).getText() !== TRUSTED_TIMEOUT_HELPER_NAME) return false;
  const variable = declaration.parent.parent;
  if (!ts.isVariableDeclaration(variable) || !(variable.parent.flags & ts.NodeFlags.Const)) return false;
  let init = variable.initializer;
  if (init && ts.isAwaitExpression(init)) init = init.expression;
  if (!init || !ts.isCallExpression(init)) return false;
  if (init.expression.kind === ts.SyntaxKind.ImportKeyword
      || ts.isIdentifier(init.expression) && init.expression.text === 'require'
        && !checker.getSymbolAtLocation(init.expression)) {
    return init.arguments.length === 1 && ts.isStringLiteralLike(init.arguments[0]) && isTimeoutModule(init.arguments[0].text, identifier.getSourceFile().fileName);
  }
  return ts.isIdentifier(init.expression)
    && importedFrom(init.expression, checker, 'importImpl', isResolverModule)
    && init.arguments.length === 2 && ts.isStringLiteralLike(init.arguments[1])
    && init.arguments[1].text === 'process/bounded-child-process.mjs';
}

/**
 * The raw sync API a call expression invokes, if any — resolved through
 * `aliases` (#3062 finding 3) so a renamed import, a `require` rename, or a
 * reassigned local all still resolve to the real API name they ultimately
 * call. Covers plain identifiers, `obj.method()`, and `obj['method']()`
 * (computed property access with a string-literal key).
 *
 * @param {ts.CallExpression} node
 * @param {{ aliasToApi: Map<string, string> } | undefined} aliases
 * @returns {string | null}
 */
function calledApi(node, aliases) {
  const expression = node.expression;
  if (ts.isIdentifier(expression)) {
    if (SYNC_APIS.has(expression.text)) return expression.text;
    return aliases?.aliasToApi.get(expression.text) ?? null;
  }
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (ts.isElementAccessExpression(expression) && ts.isStringLiteralLike(expression.argumentExpression)) {
    return expression.argumentExpression.text;
  }
  return null;
}

/**
 * The numeric value of `expr` when it is a numeric literal, a unary-minus
 * or parenthesized wrapper of one, or a `+`/`-`/`*`/`/` expression of such
 * literals — `null` when `expr` is not one of those shapes (e.g. an
 * identifier or call expression; those are not rejected by
 * `hasProvablyPositiveTimeout` below, just not provable one way or the
 * other from syntax alone).
 *
 * @param {ts.Expression} expr
 * @returns {number | null}
 */
function literalNumericValue(expr) {
  if (ts.isNumericLiteral(expr)) {
    const value = Number(expr.text.replaceAll('_', ''));
    return Number.isFinite(value) ? value : null;
  }
  if (ts.isParenthesizedExpression(expr)) return literalNumericValue(expr.expression);
  if (ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.MinusToken) {
    const operand = literalNumericValue(expr.operand);
    return operand === null ? null : -operand;
  }
  if (ts.isBinaryExpression(expr)) {
    const left = literalNumericValue(expr.left);
    const right = literalNumericValue(expr.right);
    if (left === null || right === null) return null;
    switch (expr.operatorToken.kind) {
      case ts.SyntaxKind.AsteriskToken: return left * right;
      case ts.SyntaxKind.PlusToken: return left + right;
      case ts.SyntaxKind.MinusToken: return left - right;
      case ts.SyntaxKind.SlashToken: return right === 0 ? null : left / right;
      default: return null;
    }
  }
  return null;
}

function isUndefinedKeyword(expr) {
  return expr.kind === ts.SyntaxKind.UndefinedKeyword || (ts.isIdentifier(expr) && expr.text === 'undefined');
}

/** Resolve positive bounds through lexical const bindings or imports from the
 * owning helper. Tests retain their existing lenient explicit-timeout rule. */
function isTimeoutExpressionProvablyPositive(expr, context) {
  const { lenientTimeout } = context;
  if (isUndefinedKeyword(expr)) return false;
  const numeric = literalNumericValue(expr);
  if (numeric !== null) return Number.isFinite(numeric) && numeric > 0;
  if (lenientTimeout) return true;
  const checker = context.checker;
  if (ts.isIdentifier(expr)) {
    const declaration = checker.getShorthandAssignmentValueSymbol?.(expr.parent)?.valueDeclaration
      ?? checker.getSymbolAtLocation(expr)?.valueDeclaration;
    if (declaration && ts.isVariableDeclaration(declaration)
        && declaration.parent.flags & ts.NodeFlags.Const && declaration.initializer) {
      const value = literalNumericValue(declaration.initializer);
      if (value !== null) return Number.isFinite(value) && value > 0;
    }
  }
  if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)
      && trustedTimeoutHelper(expr.expression, checker)) return true;
  return lenientTimeout;
}

/**
 * The `timeout` property's name, including the duplicate-key evasion a
 * computed, quoted key can hide behind (#3062 B/C finding 8):
 * `['timeout']: 0` or `["timeout"]: 0` is semantically the same key as a
 * plain `timeout:` property — object literals let a later key of the same
 * name silently win — so it must be recognized the same way, not skipped
 * just because `ts.isComputedPropertyName` is true.
 *
 * @param {ts.ObjectLiteralElementLike} property
 * @param {ts.SourceFile} source
 * @returns {string | null}
 */
function propertyKeyName(property, source) {
  if (!property.name) return null;
  if (!ts.isComputedPropertyName(property.name)) {
    return ts.isStringLiteralLike(property.name) ? property.name.text : property.name.getText(source);
  }
  const expression = property.name.expression;
  return ts.isStringLiteralLike(expression) ? expression.text : null;
}

/**
 * @param {ts.ObjectLiteralExpression} objectLiteral
 * @param {ts.SourceFile} source
 * @param {{ constLiterals: Map<string, number>, trustedTimeoutHelperAliases: Set<string> }} context
 * @returns {boolean}
 */
function hasProvablyPositiveTimeout(objectLiteral, source, context) {
  let timeoutIsPositive = false;
  let killIsHard = false;
  for (const property of objectLiteral.properties) {
    if (ts.isSpreadAssignment(property)) {
      killIsHard = false;
      timeoutIsPositive = false; // an unresolved spread can override/remove a preceding `timeout`
      continue;
    }
    const key = propertyKeyName(property, source);
    if (key === null && property.name && ts.isComputedPropertyName(property.name)) {
      timeoutIsPositive = false;
      killIsHard = false; // an unknown computed key can replace either option
    }
    if (key === 'killSignal') {
      killIsHard = ts.isPropertyAssignment(property) && ts.isStringLiteralLike(property.initializer)
        && property.initializer.text === 'SIGKILL';
    }
    if (key !== 'timeout') continue;
    if (ts.isPropertyAssignment(property)) {
      timeoutIsPositive = isTimeoutExpressionProvablyPositive(property.initializer, context);
    } else if (ts.isShorthandPropertyAssignment(property)) {
      // `{ ..., timeout, ... }` — same as `{ timeout: timeout }`: resolve
      // the referenced identifier the same way a property-assignment value
      // would be.
      timeoutIsPositive = isTimeoutExpressionProvablyPositive(property.name, context);
    } else {
      timeoutIsPositive = false; // e.g. a method named `timeout` — not an option value at all
    }
  }
  return timeoutIsPositive && (context.lenientTimeout || killIsHard);
}

/**
 * Calls to the bounded helper (`boundedExecSync`/`boundedExecFileSync`/
 * `boundedSpawnSync`, see src/process/bounded-child-process.mjs) are never
 * found here: they are different identifiers from the raw `execSync` /
 * `execFileSync` / `spawnSync` this gate matches, so "goes through the
 * helper" requires no special-casing below — it is the identifier match
 * failing, same as a literal `timeout` option, except covered without one.
 */
/**
 * @param {string} file - POSIX-relative path, for reporting
 * @param {string} text
 * @param {{ absoluteFile: string, reExportIndex: Map<string, Map<string, string>> } | undefined} crossFile
 *   - needed only to resolve a re-export from another local file (#3062
 *   B/C finding 8); omitted by single-file callers (including every
 *   existing unit test), which simply can't see re-exports from files
 *   they never passed in.
 */
export function findUnboundedCalls(file, text, crossFile, { lenientTimeout = false } = {}) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  // The bounded helper's own implementation is exempt from binding
  // resolution (#3062 finding 3): it necessarily calls the raw Node APIs
  // (aliased on import, e.g. `execSync as nodeExecSync`) through a
  // programmatically built options object — that is what "goes through
  // the bounded helper" means for every other file. Resolving its own
  // aliases would make this gate require boundedExecSync to call
  // boundedExecSync. Elsewhere, the raw spelling check alone still
  // catches a literal `execSync(...)`/`execFileSync(...)`/`spawnSync(...)`
  // here, if one is ever added outside the three documented wrappers.
  const aliases = file === BOUNDED_HELPER_IMPLEMENTATION_FILE
    ? undefined
    : collectChildProcessApiAliases(source, crossFile && { file: crossFile.absoluteFile, reExportIndex: crossFile.reExportIndex });
  let checker;
  const timeoutContext = {
    get checker() { return checker ??= localChecker(source); },
    lenientTimeout,
  };
  const findings = [];
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const api = calledApi(node, aliases);
      if (api && SYNC_APIS.has(api)) {
        const options = node.arguments.at(-1);
        const hasTimeout = options && ts.isObjectLiteralExpression(options)
          && hasProvablyPositiveTimeout(options, source, timeoutContext);
        if (!hasTimeout) {
          const position = source.getLineAndCharacterOfPosition(node.getStart(source));
          findings.push({ file, line: position.line + 1, api, node, source });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}

/**
 * Every actual comment token (single-line `//` or block) in `text`, via
 * the already-parsed `source`'s own token boundaries rather than a
 * standalone rescan of the raw text (#3062 finding 16).
 *
 * A marker-shaped string sitting inside a string or template literal —
 * not a real comment — must never register as an exemption; that rules
 * out a line-text regex. It also rules out an independent
 * `ts.createScanner` pass over the raw text: unlike the parser, a bare
 * scanner has no syntactic context, so it cannot tell a regex literal's
 * `/.../ ` from division — one `/` it misreads desyncs every token
 * position for the rest of the file, silently dropping every later
 * comment (this was caught by a real stale-entry regression: an existing
 * allow-listed marker past an earlier regex literal in the same file
 * stopped being found). Querying `ts.getLeadingCommentRanges` at each
 * parsed token's own start has no such ambiguity — the parser already
 * resolved it when producing that token.
 *
 * @param {ts.SourceFile} source
 * @param {string} text
 * @returns {{ pos: number, text: string }[]}
 */
function collectCommentTokens(source, text) {
  const byPos = new Map();
  const record = (ranges) => {
    for (const range of ranges ?? []) {
      if (!byPos.has(range.pos)) byPos.set(range.pos, { pos: range.pos, text: text.slice(range.pos, range.end) });
    }
  };
  const visit = (node) => {
    record(ts.getLeadingCommentRanges(text, node.getFullStart()));
    ts.forEachChild(node, visit);
  };
  visit(source);
  // Trailing content at end-of-file (after the last real token) attaches
  // only to the synthetic end-of-file token, which forEachChild never
  // visits as a child of anything.
  record(ts.getLeadingCommentRanges(text, source.endOfFileToken.getFullStart()));
  return [...byPos.values()].sort((a, b) => a.pos - b.pos);
}

/** Every `// sync-spawn: interactive <anchor>` marker found in one file's actual comments. */
export function findInteractiveMarkers(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const markers = [];
  for (const comment of collectCommentTokens(source, text)) {
    const match = comment.text.match(MARKER_RE);
    if (!match) continue;
    const { line } = source.getLineAndCharacterOfPosition(comment.pos);
    markers.push({ file, line: line + 1, anchor: match[1].toLowerCase() });
  }
  return markers;
}

// Ceiling on how far a leading comment block may run above a call before we
// stop looking for its marker — just a sanity bound, not the real stop
// condition (that's the first non-comment, non-blank line encountered).
const MARKER_LOOKBACK_LINES = 10;

/**
 * A marker exempts a finding when it sits on the call's own line (trailing
 * comment) or anywhere in the contiguous `//`-comment block immediately
 * above it. Walking the actual lines (rather than a fixed line-count window)
 * means this can't accidentally cross into an unrelated call's marker.
 */
function markerForFinding(markers, finding, lines) {
  const byLine = new Map(markers.filter((m) => m.file === finding.file).map((m) => [m.line, m]));
  for (let line = finding.line; line >= Math.max(1, finding.line - MARKER_LOOKBACK_LINES); line -= 1) {
    const marker = byLine.get(line);
    if (marker) return marker;
    if (line !== finding.line && !/^\s*(\/\/.*)?$/.test(lines[line - 1] ?? '')) break;
  }
  return undefined;
}

export function loadAllowList(root) {
  const file = path.join(root, ALLOWLIST_RELATIVE_PATH);
  if (!fs.existsSync(file)) return { entries: [], file };
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
  return { entries, file };
}

function allowListKey(file, anchor) {
  return `${file}::${anchor}`;
}

/**
 * Validate the allow-list registry itself, independent of any one scan:
 *   - every entry's `kind` must be `"interactive"` (the only supported kind
 *     today; anything else is a data error, not a future feature flag)
 *   - every entry must be unique (no two entries for the same file+anchor)
 *   - every entry must correspond to exactly one marker that is actually
 *     attached to an exempted call ("stale" = 0 matches — listed but no
 *     longer present or never attached to a real call; "ambiguous" = 2+
 *     matches — the anchor does not uniquely identify one call, so the
 *     exemption's target is unclear)
 *
 * `attachedMarkerCountByKey` — not "does a marker with this text exist
 * anywhere in the file" — is what makes "stale" and "ambiguous" meaningful
 * (#3062 finding 16): it counts markers that `markerForFinding` actually
 * resolved to a real unbounded-call finding, so a marker-shaped comment
 * sitting next to nothing (or that never reaches a call) does not count as
 * covering an entry.
 *
 * Runs unconditionally (not gated behind `--enforce-product`): a stale,
 * duplicate, ambiguous, or malformed allow-list is a bug in the registry
 * itself, not an in-progress migration count.
 *
 * @param {{ entries: Array<{file: string, anchor: string, kind: string}> }} allowList
 * @param {Map<string, number>} attachedMarkerCountByKey
 */
export function validateAllowList(allowList, attachedMarkerCountByKey) {
  const problems = [];
  const seenKeys = new Set();
  for (const entry of allowList.entries) {
    const key = allowListKey(entry.file, entry.anchor);
    if (seenKeys.has(key)) {
      problems.push(`${entry.file}::${entry.anchor}: duplicate allow-list entry for the same file+anchor`);
      continue;
    }
    seenKeys.add(key);

    if (entry.kind !== 'interactive') {
      problems.push(`${entry.file}::${entry.anchor}: unsupported kind ${JSON.stringify(entry.kind)} (only "interactive" is supported)`);
      continue;
    }

    const count = attachedMarkerCountByKey.get(key) ?? 0;
    if (count === 0) {
      problems.push(`${entry.file}::${entry.anchor}: stale allow-list entry — no "// sync-spawn: interactive ${entry.anchor}" marker is attached to an exempted call in ${entry.file}`);
    } else if (count > 1) {
      problems.push(`${entry.file}::${entry.anchor}: ambiguous allow-list entry — anchor "${entry.anchor}" is attached to ${count} different calls in ${entry.file}; each anchor must identify exactly one call`);
    }
  }
  return problems;
}

function fixFile(file, text, findings) {
  const timeout = TEST_PROCESS_TIMEOUT_MS.toLocaleString('en-US').replaceAll(',', '_');
  const edits = findings.map(({ node, source }) => {
    const last = node.arguments.at(-1);
    if (last && ts.isObjectLiteralExpression(last)) {
      const prefix = last.properties.length ? ', ' : ' ';
      return { at: last.getEnd() - 1, text: `${prefix}timeout: ${timeout} ` };
    }
    return { at: node.getEnd() - 1, text: `, { timeout: ${timeout} }` };
  }).sort((a, b) => b.at - a.at);
  let fixed = text;
  for (const edit of edits) fixed = fixed.slice(0, edit.at) + edit.text + fixed.slice(edit.at);
  fs.writeFileSync(file, fixed);
}

/**
 * Original surface, unchanged: scans test/ only, with the pre-existing
 * hard-fail (or `--fix`) behavior. Nothing under #3062 altered this.
 */
export function check(root, { fix = false } = {}) {
  const findings = [];
  const testFiles = sourceFiles(root, ['test']);
  const reExportIndex = buildReExportIndex(testFiles);
  for (const file of testFiles) {
    const text = fs.readFileSync(file, 'utf8');
    // lenientTimeout: true — see isTimeoutExpressionProvablyPositive's doc
    // comment. The strict (#3062 B/C finding 8) rule targets product code;
    // test fixtures routinely reference a timeout constant imported from
    // elsewhere, which strict mode can't resolve and was never meant to.
    const fileFindings = findUnboundedCalls(toPosixRelative(root, file), text, { absoluteFile: file, reExportIndex }, { lenientTimeout: true });
    findings.push(...fileFindings);
    if (fix && fileFindings.length) fixFile(file, text, fileFindings);
  }
  return findings.map(({ file, line, api }) => ({ file, line, api }));
}

/**
 * Product-code scan (src/, tools/, bin/, #3062): every unbounded call,
 * classified as `allowListed` (marker + matching registry entry) or
 * `violation` (still needs the helper, a literal timeout, or a new
 * allow-list entry). Also returns `registryProblems` (allow-list
 * validation against markers actually attached to a call — see
 * `validateAllowList`).
 */
export function checkProduct(root) {
  const allowList = loadAllowList(root);
  const attachedMarkerCountByKey = new Map();
  const allFindings = [];
  const productFiles = sourceFiles(root, PRODUCT_DIRS);
  // Built once, across every product file, so a re-export chain resolves
  // regardless of which file's exports get scanned first (#3062 B/C
  // finding 8).
  const reExportIndex = buildReExportIndex(productFiles);

  for (const file of productFiles) {
    const relFile = toPosixRelative(root, file);
    const text = fs.readFileSync(file, 'utf8');
    const markers = findInteractiveMarkers(relFile, text);
    const lines = text.split('\n');
    for (const finding of findUnboundedCalls(relFile, text, { absoluteFile: file, reExportIndex })) {
      const marker = markerForFinding(markers, finding, lines);
      if (marker) {
        const key = allowListKey(marker.file, marker.anchor);
        attachedMarkerCountByKey.set(key, (attachedMarkerCountByKey.get(key) ?? 0) + 1);
      }
      allFindings.push({
        file: finding.file,
        line: finding.line,
        api: finding.api,
        anchor: marker?.anchor ?? null,
      });
    }
  }

  const registryProblems = validateAllowList(allowList, attachedMarkerCountByKey);

  const pinnedSources = loadEvidencePinnedBenchmarkSources(root);
  const violations = [];
  const allowListed = [];
  const evidencePinned = [];
  for (const finding of allFindings) {
    const key = finding.anchor ? allowListKey(finding.file, finding.anchor) : null;
    const entry = key ? allowList.entries.find((e) => allowListKey(e.file, e.anchor) === key) : undefined;
    if (entry && entry.kind === 'interactive') allowListed.push(finding);
    else if (pinnedSources.has(finding.file)) evidencePinned.push(finding);
    else violations.push(finding);
  }

  return { violations, allowListed, evidencePinned, registryProblems };
}

export const BENCHMARK_CLAIMS_RELATIVE_PATH = 'docs/storage/evidence/claims.v1.json';

/**
 * Benchmark scripts whose bytes are digest-pinned by checked-in benchmark
 * evidence. Editing one, even to add a bound or a marker comment, makes the
 * storage-claims gate reject the evidence as stale until the benchmark is
 * re-measured, so they cannot be converted in an ordinary change. They are
 * reported, not failed. The exemption is narrow by construction: the file
 * must be under tools/benchmarks/ AND be listed as a source of a claim in
 * the evidence registry. Bound the call the next time the benchmark is
 * re-measured (#3078).
 */
export function loadEvidencePinnedBenchmarkSources(root) {
  const pinned = new Set();
  let registry;
  try {
    registry = JSON.parse(fs.readFileSync(path.join(root, BENCHMARK_CLAIMS_RELATIVE_PATH), 'utf8'));
  } catch {
    return pinned;
  }
  for (const claim of Array.isArray(registry?.claims) ? registry.claims : []) {
    for (const file of Array.isArray(claim?.sourceFiles) ? claim.sourceFiles : []) {
      if (typeof file === 'string' && file.startsWith('tools/benchmarks/')) pinned.add(file);
    }
  }
  return pinned;
}

function topLevelDir(relFile) {
  return relFile.split('/')[0];
}

function printProductReport({ violations, allowListed, evidencePinned = [] }, { enforced }) {
  const counts = new Map();
  for (const dir of PRODUCT_DIRS) counts.set(dir, { violations: 0, allowListed: 0 });
  for (const finding of violations) {
    const dir = topLevelDir(finding.file);
    if (!counts.has(dir)) counts.set(dir, { violations: 0, allowListed: 0 });
    counts.get(dir).violations += 1;
  }
  for (const finding of allowListed) {
    const dir = topLevelDir(finding.file);
    if (!counts.has(dir)) counts.set(dir, { violations: 0, allowListed: 0 });
    counts.get(dir).allowListed += 1;
  }

  const label = enforced ? 'enforced' : 'report mode — not yet enforced';
  console.log(`Sync child-process timeout gate — product code (src/, tools/, bin/) [${label}]:`);
  for (const [dir, counted] of counts) {
    console.log(`  ${dir}: ${counted.violations} unbounded (${counted.allowListed} allow-listed interactive)`);
  }
  const total = [...counts.values()].reduce((sum, c) => sum + c.violations, 0);
  console.log(`  total unbounded (non-allow-listed): ${total}`);
  if (evidencePinned.length > 0) {
    console.log(`  evidence-pinned benchmark sources (reported, not enforced): ${evidencePinned.map((f) => `${f.file}:${f.line}`).join(', ')}`);
  }
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  // --root lets tests point the gate at a synthetic fixture tree instead of
  // this repo, so "report mode never fails" etc. don't depend on the real
  // (mutable, in-progress) product-code violation count.
  const rootFlagIndex = process.argv.indexOf('--root');
  const root = rootFlagIndex !== -1 && process.argv[rootFlagIndex + 1]
    ? path.resolve(process.argv[rootFlagIndex + 1])
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const fix = process.argv.includes('--fix');
  const enforceProduct = process.argv.includes('--enforce-product');

  // 1. test/ — unchanged hard-fail (or --fix) behavior.
  const testFindings = check(root, { fix });
  let failed = false;
  if (fix) {
    console.log(`Added ${TEST_PROCESS_TIMEOUT_MS / 1000}s timeouts to ${testFindings.length} synchronous child-process calls in test/.`);
  } else if (testFindings.length) {
    for (const finding of testFindings) console.error(`${finding.file}:${finding.line}: ${finding.api} has no explicit timeout`);
    console.error(`Found ${testFindings.length} unbounded synchronous child-process calls in test/.`);
    failed = true;
  } else {
    console.log('Synchronous child-process timeout gate (test/): 0 unbounded calls.');
  }

  // 2. src/, tools/, bin/ — report always; enforce only with --enforce-product.
  const product = checkProduct(root);
  printProductReport(product, { enforced: enforceProduct });

  if (product.registryProblems.length) {
    for (const problem of product.registryProblems) console.error(`${ALLOWLIST_RELATIVE_PATH}: ${problem}`);
    failed = true;
  }

  if (enforceProduct && product.violations.length) {
    for (const finding of product.violations) {
      console.error(`${finding.file}:${finding.line}: ${finding.api} has no positive timeout with SIGKILL, does not go through the bounded helper, and is not on the allow-list`);
    }
    failed = true;
  }

  if (failed) process.exitCode = 1;
}
