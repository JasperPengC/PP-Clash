import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export function checkArchitecture(root = 'src') {
  const walk = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(file) : /\.tsx?$/.test(file) ? [file] : [];
  });
  const files = walk(root);
  const graph = new Map(files.map(file => [file, []]));
  const errors = [];
  for (const file of files) {
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    function inspect(node) {
      const declaration = ts.isImportDeclaration(node) || ts.isExportDeclaration(node);
      const specifier = declaration ? node.moduleSpecifier : ts.isImportTypeNode(node) ? node.argument.literal : undefined;
      if (specifier && ts.isStringLiteral(specifier) && specifier.text.startsWith('.')) {
        const stem = path.normalize(path.join(path.dirname(file), specifier.text));
        const target = [stem, `${stem}.ts`, `${stem}.tsx`, path.join(stem, 'index.ts')].find(candidate => graph.has(candidate));
        if (target) {
          const from = path.relative(root, file).split(path.sep)[0];
          const to = path.relative(root, target).split(path.sep)[0];
          if (['domain', 'core'].includes(from) && ['store', 'application', 'pages', 'components', 'bootstrap'].includes(to)) {
            errors.push(`底层模块向上依赖：${file} → ${target}`);
          }
          const clause = ts.isImportDeclaration(node) ? node.importClause : undefined;
          const bindings = clause?.namedBindings;
          const typeOnly = ts.isImportTypeNode(node) || clause?.isTypeOnly || node.isTypeOnly
            || (bindings && ts.isNamedImports(bindings) && !clause.name && bindings.elements.length > 0 && bindings.elements.every(item => item.isTypeOnly));
          if (!typeOnly) graph.get(file).push(target);
        }
      }
      ts.forEachChild(node, inspect);
    }
    inspect(source);
  }
  const visited = new Set();
  const active = new Set();
  function visit(file, chain) {
    if (active.has(file)) { errors.push(`运行时循环依赖：${[...chain, file].join(' → ')}`); return; }
    if (visited.has(file)) return;
    active.add(file);
    for (const next of graph.get(file)) visit(next, [...chain, file]);
    active.delete(file); visited.add(file);
  }
  files.forEach(file => visit(file, []));
  return { files: files.length, errors };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = checkArchitecture();
  if (result.errors.length) { console.error(result.errors.join('\n')); process.exitCode = 1; }
  else console.log(`架构边界通过：${result.files} 个模块，无底层向上依赖或静态运行时循环`);
}
