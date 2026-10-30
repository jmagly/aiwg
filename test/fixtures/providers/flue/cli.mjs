// Synthetic discovery output; artifact operations remain owned by the real server.
const [operation, ...args] = process.argv.slice(2);
if (args.includes('server-failure')) {
  console.error('Synthetic discovery failure');
  process.exit(1);
}
if (operation === 'discover') {
  const typeIndex = args.indexOf('--type');
  const type = typeIndex < 0 ? 'skill' : args[typeIndex + 1];
  console.log(JSON.stringify({ matches: [{ type, name: 'fixture-skill', summary: args[0] }] }));
} else if (operation === 'show') {
  if (!args.includes('--rules') || !args.includes('--with-rule-bodies')) {
    console.error('Governing rule drill-in missing');
    process.exit(1);
  }
  const heading = args.indexOf('--section');
  console.log(JSON.stringify({
    type: args[0], name: args[1], outline: ['Procedure'],
    ...(heading < 0 ? {} : { section: args[heading + 1] }),
    governingRules: [{ name: 'fixture-rule', body: 'Keep artifacts contained.' }],
  }));
} else {
  console.error('Fixture supports only discover/show');
  process.exit(1);
}
