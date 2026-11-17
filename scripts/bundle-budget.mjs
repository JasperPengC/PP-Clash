/** 预算统计静态依赖闭包；动态导入只在相应页面打开后计入。 */
export function inspectInitialDependencies(chunks, ...roots) {
  const visited = new Set();
  const modules = new Set();
  let bytes = 0;
  function visit(file) {
    if (visited.has(file) || !chunks[file]) return;
    visited.add(file);
    const chunk = chunks[file];
    bytes += chunk.bytes;
    chunk.modules.forEach(id => modules.add(id));
    chunk.imports.forEach(visit);
  }
  roots.forEach(visit);
  return { bytes, files: [...visited], modules: [...modules] };
}

export function bundleBudget() {
  return {
    name: 'ppclash-bundle-budget',
    apply: 'build',
    generateBundle: { order: 'post', handler(_, bundle) {
      const output = Object.values(bundle).filter(item => item.type === 'chunk');
      const chunks = Object.fromEntries(output.map(chunk => [chunk.fileName, {
        bytes: Buffer.byteLength(chunk.code), imports: chunk.imports,
        modules: Object.keys(chunk.modules).map(id => id.replaceAll('\\', '/').replace(process.cwd().replaceAll('\\', '/') + '/', '')),
      }]));
      const find = suffix => {
        const item = output.find(chunk => chunk.facadeModuleId?.replaceAll('\\', '/').endsWith(suffix))
          ?? output.find(chunk => Object.keys(chunk.modules).some(id => id.replaceAll('\\', '/').endsWith(suffix)));
        if (!item) this.error(`构建预算缺少入口：${suffix}`);
        return item.fileName;
      };
      const entry = output.find(chunk => chunk.isEntry)?.fileName;
      const views = {
        bootstrap: inspectInitialDependencies(chunks, entry),
        main: inspectInitialDependencies(chunks, entry, find('/bootstrap/main-window.tsx'), find('/pages/Overview.tsx')),
        tray: inspectInitialDependencies(chunks, entry, find('/components/TrayPanel.tsx')),
      };
      const limits = { bootstrap: 500_000, main: 500_000, tray: 400_000 };
      for (const [name, view] of Object.entries(views)) {
        if (view.bytes > limits[name]) this.error(`${name} 初始 JS 依赖 ${view.bytes} B，超过预算 ${limits[name]} B`);
        const forbidden = view.modules.filter(id => /node_modules\/(?:@codemirror|@lezer|acorn)\//.test(id)
          || /src\/(?:pages\/Override|components\/CodeEditor)/.test(id)
          || (name === 'tray' && /src\/(?:store\/app|pages\/|bootstrap\/main-window)/.test(id)));
        if (forbidden.length) this.error(`${name} 提前加载了不需要的模块：${forbidden.join(', ')}`);
      }
      this.emitFile({ type: 'asset', fileName: 'bundle-report.json', source: JSON.stringify({ limits, views, chunks }, null, 2) });
      for (const [name, view] of Object.entries(views)) console.log(`[依赖预算] ${name}: ${(view.bytes / 1000).toFixed(1)} KB / ${limits[name] / 1000} KB`);
    } },
  };
}
