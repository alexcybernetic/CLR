import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const legalDocuments = new Map<string, URL>([
  ['/LICENSE.txt', new URL('../LICENSE', import.meta.url)],
  ['/THIRD_PARTY_NOTICES.md', new URL('../THIRD_PARTY_NOTICES.md', import.meta.url)],
]);

const relativeDeploymentBase = `(()=>{const p=location.pathname;if(p.endsWith('/')||/\\.html?$/i.test(p))return;const b=document.createElement('base');b.href=p+'/';document.head.prepend(b)})()`;

/**
 * Keep the static artifact relocatable even when a host maps an extensionless
 * directory route to index.html without first redirecting it to a trailing
 * slash. The base is derived entirely from the requested document URL; no
 * deployment path is compiled into CLR.
 */
function relativeDeploymentBasePlugin(): Plugin {
  return {
    name: 'clr-relative-deployment-base',
    apply: 'build',
    transformIndexHtml: {
      order: 'pre',
      handler: () => [{
        tag: 'script',
        attrs: { 'data-clr-relative-base': '' },
        children: relativeDeploymentBase,
        injectTo: 'head-prepend',
      }],
    },
  };
}

/** Serve and package the canonical root documents without maintaining copies. */
function legalDocumentsPlugin(): Plugin {
  return {
    name: 'clr-legal-documents',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = request.url?.split('?', 1)[0];
        const source = path ? legalDocuments.get(path) : undefined;
        if (!source) return next();
        response.statusCode = 200;
        response.setHeader('Content-Type', 'text/plain; charset=utf-8');
        response.end(readFileSync(source));
      });
    },
    generateBundle() {
      for (const [path, source] of legalDocuments) {
        this.emitFile({
          type: 'asset',
          fileName: path.slice(1),
          source: readFileSync(source),
        });
      }
    },
  };
}

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  cacheDir: fileURLToPath(new URL('../node_modules/.vite/appweb', import.meta.url)),
  base: './',
  plugins: [relativeDeploymentBasePlugin(), react(), legalDocumentsPlugin()],
  build: {
    target: 'es2022',
    sourcemap: false,
  },
  worker: {
    format: 'es',
  },
});
