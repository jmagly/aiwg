/**
 * TestCaseGenerator - Generate test cases from use case scenarios
 *
 * Transforms parsed use case scenarios into structured test case specifications
 * following TC-XXX format with test steps, expected results, and data requirements.
 *
 * @module src/testing/generators/test-case-generator
 * @implements @.aiwg/requirements/use-cases/UC-009-generate-test-artifacts.md
 * @architecture @docs/architecture/cli/index.md
 * @nfr @.aiwg/requirements/nfr-modules/performance.md - NFR-TEST-01 (<10min for 100 reqs)
 * @tests @test/unit/testing/test-case-generator.test.ts
 * @depends @src/testing/generators/use-case-parser.ts
 * @agent @agentic/code/frameworks/sdlc-complete/agents/test-engineer.md
 */

import { UseCaseDocument, UseCaseScenario, UseCaseStep } from './use-case-parser.js';

// ===========================
// Interfaces
// ===========================

export interface TestStep {
  number: number;
  action: string;
  expectedResult: string;
  testData?: string;
}

export interface TestCase {
  id: string;
  name: string;
  description: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
  type: 'positive' | 'negative' | 'boundary' | 'error';
  level: 'unit' | 'integration' | 'e2e';
  preconditions: string[];
  steps: TestStep[];
  postconditions: string[];
  testData: TestDataRequirement[];
  traceability: {
    useCaseId: string;
    scenarioId: string;
    nfrs: string[];
  };
  tags: string[];
  estimatedDuration?: number;  // milliseconds
}

export interface TestDataRequirement {
  name: string;
  type: string;
  constraints: string[];
  examples: string[];
}

export interface TestSuite {
  id: string;
  name: string;
  description: string;
  useCaseId: string;
  testCases: TestCase[];
  coverage: {
    mainScenario: boolean;
    extensionsCovered: number;
    exceptionsCovered: number;
    total: number;
  };
  generatedAt: string;
}

export interface GenerationOptions {
  includeNegativeTests?: boolean;
  includeBoundaryTests?: boolean;
  includeErrorTests?: boolean;
  testLevels?: Array<'unit' | 'integration' | 'e2e'>;
  maxTestsPerScenario?: number;
  generateDataRequirements?: boolean;
}

export interface GenerationResult {
  success: boolean;
  suite?: TestSuite;
  errors: string[];
  warnings: string[];
  stats: {
    totalTestCases: number;
    positiveTests: number;
    negativeTests: number;
    boundaryTests: number;
    errorTests: number;
    generationTimeMs: number;
  };
}

// ===========================
// TestCaseGenerator Class
// ===========================

export class TestCaseGenerator {
  private options: Required<GenerationOptions>;
  private testCounter: number = 0;

  constructor(options: GenerationOptions = {}) {
    this.options = {
      includeNegativeTests: true,
      includeBoundaryTests: true,
      includeErrorTests: true,
      testLevels: ['unit', 'integration', 'e2e'],
      maxTestsPerScenario: 10,
      generateDataRequirements: true,
      ...options
    };
  }

  /**
   * Generate test suite from a use case document
   *
   * @param document - Parsed use case document
   * @returns Generation result with test suite
   */
  generate(document: UseCaseDocument): GenerationResult {
    const startTime = Date.now();
    const warnings: string[] = [];
    const testCases: TestCase[] = [];

    this.testCounter = 0;

    try {
      // Generate tests for main scenario
      const mainTests = this.generateScenarioTests(
        document.mainScenario,
        document,
        'main'
      );
      testCases.push(...mainTests);

      // Generate tests for extensions
      for (const extension of document.extensions) {
        const extTests = this.generateScenarioTests(
          extension,
          document,
          'extension'
        );
        testCases.push(...extTests);
      }

      // Generate tests for exceptions
      for (const exception of document.exceptions) {
        const excTests = this.generateScenarioTests(
          exception,
          document,
          'exception'
        );
        testCases.push(...excTests);
      }

      // Generate negative tests if enabled
      if (this.options.includeNegativeTests) {
        const negativeTests = this.generateNegativeTests(document);
        testCases.push(...negativeTests);
      }

      // Generate boundary tests if enabled
      if (this.options.includeBoundaryTests) {
        const boundaryTests = this.generateBoundaryTests(document);
        testCases.push(...boundaryTests);
      }

      const generationTimeMs = Date.now() - startTime;

      const suite: TestSuite = {
        id: `TS-${document.id}`,
        name: `Test Suite: ${document.title}`,
        description: `Auto-generated test suite for ${document.id}`,
        useCaseId: document.id,
        testCases,
        coverage: {
          mainScenario: true,
          extensionsCovered: document.extensions.length,
          exceptionsCovered: document.exceptions.length,
          total: testCases.length
        },
        generatedAt: new Date().toISOString()
      };

      return {
        success: true,
        suite,
        errors: [],
        warnings,
        stats: {
          totalTestCases: testCases.length,
          positiveTests: testCases.filter(t => t.type === 'positive').length,
          negativeTests: testCases.filter(t => t.type === 'negative').length,
          boundaryTests: testCases.filter(t => t.type === 'boundary').length,
          errorTests: testCases.filter(t => t.type === 'error').length,
          generationTimeMs
        }
      };
    } catch (error: any) {
      return {
        success: false,
        errors: [`Generation failed: ${error.message}`],
        warnings,
        stats: {
          totalTestCases: 0,
          positiveTests: 0,
          negativeTests: 0,
          boundaryTests: 0,
          errorTests: 0,
          generationTimeMs: Date.now() - startTime
        }
      };
    }
  }

  /**
   * Generate test cases from multiple use case documents
   *
   * @param documents - Array of parsed use case documents
   * @returns Map of use case ID to generation result
   */
  generateBatch(documents: UseCaseDocument[]): Map<string, GenerationResult> {
    const results = new Map<string, GenerationResult>();

    for (const doc of documents) {
      results.set(doc.id, this.generate(doc));
    }

    return results;
  }

  // ===========================
  // Private Generation Methods
  // ===========================

  private generateScenarioTests(
    scenario: UseCaseScenario,
    document: UseCaseDocument,
    scenarioType: 'main' | 'extension' | 'exception'
  ): TestCase[] {
    const testCases: TestCase[] = [];

    // Generate one positive test for the happy path
    const positiveTest = this.createPositiveTest(scenario, document);
    testCases.push(positiveTest);

    // For extensions and exceptions, generate error handling tests
    if (scenarioType === 'exception' && this.options.includeErrorTests) {
      const errorTest = this.createErrorTest(scenario, document);
      testCases.push(errorTest);
    }

    return testCases;
  }

  private createPositiveTest(
    scenario: UseCaseScenario,
    document: UseCaseDocument
  ): TestCase {
    const testId = this.nextTestId(document.id);
    const level = this.determineTestLevel(scenario);

    const steps: TestStep[] = scenario.steps.map((step, index) => ({
      number: index + 1,
      action: this.actionToTestAction(step),
      expectedResult: this.inferExpectedResult(step, scenario.steps[index + 1]),
      testData: this.inferTestData(step)
    }));

    const testData = this.options.generateDataRequirements
      ? this.extractDataRequirements(scenario)
      : [];

    return {
      id: testId,
      name: `${scenario.name} - Happy Path`,
      description: `Verify ${scenario.name} completes successfully`,
      priority: document.priority,
      type: 'positive',
      level,
      preconditions: [...document.preconditions, ...scenario.preconditions],
      steps,
      postconditions: [...document.postconditions, ...scenario.postconditions],
      testData,
      traceability: {
        useCaseId: document.id,
        scenarioId: scenario.id,
        nfrs: document.nfrs
      },
      tags: [document.id, scenario.type, level],
      estimatedDuration: this.estimateDuration(steps.length, level)
    };
  }

  private createErrorTest(
    scenario: UseCaseScenario,
    document: UseCaseDocument
  ): TestCase {
    const testId = this.nextTestId(document.id);
    const level = this.determineTestLevel(scenario);

    const steps: TestStep[] = [{
      number: 1,
      action: `Trigger ${scenario.name} condition`,
      expectedResult: 'System handles error gracefully'
    }, {
      number: 2,
      action: 'Verify error handling',
      expectedResult: scenario.steps[0]?.action || 'Error is handled appropriately'
    }];

    return {
      id: testId,
      name: `${scenario.name} - Error Handling`,
      description: `Verify system handles ${scenario.name} correctly`,
      priority: document.priority,
      type: 'error',
      level,
      preconditions: document.preconditions,
      steps,
      postconditions: [],
      testData: [],
      traceability: {
        useCaseId: document.id,
        scenarioId: scenario.id,
        nfrs: document.nfrs
      },
      tags: [document.id, 'error', level],
      estimatedDuration: this.estimateDuration(steps.length, level)
    };
  }

  private generateNegativeTests(document: UseCaseDocument): TestCase[] {
    const tests: TestCase[] = [];
    const mainScenario = document.mainScenario;

    // Generate negative test for invalid input
    if (mainScenario.steps.some(s => s.actor === 'user')) {
      const testId = this.nextTestId(document.id);

      tests.push({
        id: testId,
        name: 'Invalid Input Handling',
        description: 'Verify system rejects invalid input',
        priority: 'high',
        type: 'negative',
        level: 'unit',
        preconditions: document.preconditions,
        steps: [{
          number: 1,
          action: 'Provide invalid input',
          expectedResult: 'System displays validation error'
        }, {
          number: 2,
          action: 'Verify system state unchanged',
          expectedResult: 'No data corruption or state change'
        }],
        postconditions: ['System remains in valid state'],
        testData: [{
          name: 'invalidInput',
          type: 'string',
          constraints: ['null', 'empty', 'malformed'],
          examples: ['null', '""', '<script>alert(1)</script>']
        }],
        traceability: {
          useCaseId: document.id,
          scenarioId: `${document.id}-NEG`,
          nfrs: document.nfrs
        },
        tags: [document.id, 'negative', 'validation'],
        estimatedDuration: 1000
      });
    }

    return tests;
  }

  private generateBoundaryTests(document: UseCaseDocument): TestCase[] {
    const tests: TestCase[] = [];

    // Generate boundary test for data limits
    const testId = this.nextTestId(document.id);

    tests.push({
      id: testId,
      name: 'Boundary Value Testing',
      description: 'Verify system handles boundary values correctly',
      priority: 'medium',
      type: 'boundary',
      level: 'unit',
      preconditions: document.preconditions,
      steps: [{
        number: 1,
        action: 'Test with minimum valid value',
        expectedResult: 'System accepts minimum value'
      }, {
        number: 2,
        action: 'Test with maximum valid value',
        expectedResult: 'System accepts maximum value'
      }, {
        number: 3,
        action: 'Test with value just below minimum',
        expectedResult: 'System rejects value'
      }, {
        number: 4,
        action: 'Test with value just above maximum',
        expectedResult: 'System rejects value'
      }],
      postconditions: [],
      testData: [{
        name: 'boundaryValues',
        type: 'number',
        constraints: ['min', 'max', 'min-1', 'max+1'],
        examples: ['0', '100', '-1', '101']
      }],
      traceability: {
        useCaseId: document.id,
        scenarioId: `${document.id}-BND`,
        nfrs: document.nfrs
      },
      tags: [document.id, 'boundary', 'validation'],
      estimatedDuration: 2000
    });

    return tests;
  }

  // ===========================
  // Helper Methods
  // ===========================

  private nextTestId(useCaseId: string): string {
    this.testCounter++;
    return `TC-${useCaseId.replace('UC-', '')}-${String(this.testCounter).padStart(3, '0')}`;
  }

  private determineTestLevel(scenario: UseCaseScenario): 'unit' | 'integration' | 'e2e' {
    const stepCount = scenario.steps.length;
    const hasExternalActor = scenario.steps.some(s => s.actor === 'external');

    if (hasExternalActor) return 'e2e';
    if (stepCount > 5) return 'integration';
    return 'unit';
  }

  private actionToTestAction(step: UseCaseStep): string {
    const action = step.action;

    // Convert use case language to test language
    if (step.actor === 'user') {
      return action.replace(/^user\s*/i, 'User performs: ');
    } else if (step.actor === 'system') {
      return `Verify system ${action.toLowerCase()}`;
    }

    return action;
  }

  private inferExpectedResult(step: UseCaseStep, nextStep?: UseCaseStep): string {
    if (step.expectedResult) {
      return step.expectedResult;
    }

    // Infer from action
    const action = step.action.toLowerCase();

    if (action.includes('display') || action.includes('show')) {
      return 'Correct information is displayed';
    }
    if (action.includes('save') || action.includes('store')) {
      return 'Data is persisted successfully';
    }
    if (action.includes('validate') || action.includes('verify')) {
      return 'Validation passes';
    }
    if (action.includes('navigate') || action.includes('redirect')) {
      return 'User is redirected to correct page';
    }
    if (action.includes('send') || action.includes('notify')) {
      return 'Notification is sent successfully';
    }

    // Default based on next step
    if (nextStep) {
      return `System is ready for: ${nextStep.action}`;
    }

    return 'Action completes successfully';
  }

  private inferTestData(step: UseCaseStep): string | undefined {
    const action = step.action.toLowerCase();

    if (action.includes('enter') || action.includes('input')) {
      return 'Valid test input';
    }
    if (action.includes('select') || action.includes('choose')) {
      return 'Valid selection';
    }
    if (action.includes('upload')) {
      return 'Valid test file';
    }

    return undefined;
  }

  private extractDataRequirements(scenario: UseCaseScenario): TestDataRequirement[] {
    const requirements: TestDataRequirement[] = [];

    for (const step of scenario.steps) {
      if (step.actor === 'user') {
        const action = step.action.toLowerCase();

        if (action.includes('enter') || action.includes('input')) {
          requirements.push({
            name: 'userInput',
            type: 'string',
            constraints: ['non-empty', 'valid format'],
            examples: ['test@example.com', 'Test User']
          });
        }

        if (action.includes('select') || action.includes('choose')) {
          requirements.push({
            name: 'selection',
            type: 'option',
            constraints: ['valid option'],
            examples: ['option1', 'option2']
          });
        }
      }
    }

    return requirements;
  }

  private estimateDuration(stepCount: number, level: 'unit' | 'integration' | 'e2e'): number {
    const baseTime = {
      unit: 100,
      integration: 500,
      e2e: 2000
    };

    return baseTime[level] * stepCount;
  }
}
