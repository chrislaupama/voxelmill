import { readFile, readdir } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import path from 'node:path';

const root = process.cwd();
const distDirectory = path.join(root, 'dist');
const budgets = JSON.parse(await readFile(path.join(root, 'quality/budgets.json'), 'utf8'));

async function filesBelow(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(absolute));
    else files.push(absolute);
  }
  return files;
}

const files = await filesBelow(distDirectory);
const measurements = await Promise.all(files.map(async (absolute) => {
  const bytes = await readFile(absolute);
  return {
    file: path.relative(distDirectory, absolute),
    bytes: bytes.length,
    gzipBytes: gzipSync(bytes, { level: 9 }).length,
  };
}));

const sum = (extension, field = 'bytes') => measurements
  .filter((measurement) => measurement.file.endsWith(extension))
  .reduce((total, measurement) => total + measurement[field], 0);

const document = await readFile(path.join(distDirectory, 'index.html'), 'utf8');
const initialJavaScriptFiles = new Set(
  [...document.matchAll(/<script[^>]+src=["']([^"']+\.js)["']/gu)]
    .map((match) => match[1].replace(/^\//u, '')),
);
const sumInitialJavaScript = (field = 'bytes') => measurements
  .filter((measurement) => initialJavaScriptFiles.has(measurement.file))
  .reduce((total, measurement) => total + measurement[field], 0);

const totals = {
  initialJavaScriptBytes: sumInitialJavaScript(),
  initialJavaScriptGzipBytes: sumInitialJavaScript('gzipBytes'),
  totalJavaScriptBytes: sum('.js'),
  totalJavaScriptGzipBytes: sum('.js', 'gzipBytes'),
  stylesheetBytes: sum('.css'),
  documentBytes: sum('.html'),
};

const failures = Object.entries(budgets).flatMap(([metric, budget]) => {
  const actual = totals[metric];
  return actual > budget ? [`${metric}: ${actual.toLocaleString()} > ${budget.toLocaleString()}`] : [];
});

console.log(JSON.stringify({ totals, budgets, initialJavaScriptFiles: [...initialJavaScriptFiles], files: measurements }, null, 2));
if (failures.length) {
  console.error(`Bundle budgets exceeded:\n- ${failures.join('\n- ')}`);
  process.exitCode = 1;
}
