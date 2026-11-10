// Fake review model: echoes stdin and its arguments as JSON.
let data = '';
process.stdin.on('data', (c) => { data += c; });
process.stdin.on('end', () => process.stdout.write(JSON.stringify({ in: data, argv: process.argv.slice(2) })));
