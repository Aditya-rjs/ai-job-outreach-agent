const { execSync } = require('child_process');
const path = require('path');

const tsTestPath = path.join(__dirname, 'verify-openrouter-fallback.ts');

try {
  execSync(`npx tsx "${tsTestPath}"`, {
    stdio: 'inherit',
    cwd: path.resolve(__dirname, '..'),
  });
} catch (err) {
  process.exit(1);
}
