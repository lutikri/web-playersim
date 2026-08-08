import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const LEVEL_CONFIG_PATH = fileURLToPath(new URL('./src/config/level-config.json', import.meta.url));

function levelConfigWriter(): Plugin {
  return {
    name: 'playersim-level-config-writer',
    configureServer(server) {
      server.middlewares.use('/__save-level-config', (request, response, next) => {
        if (request.method !== 'POST') {
          next();
          return;
        }
        let body = '';
        request.setEncoding('utf8');
        request.on('data', (chunk: string) => {
          body += chunk;
          if (body.length > 2_000_000) request.destroy();
        });
        request.on('end', () => {
          void (async () => {
            try {
              const config: unknown = JSON.parse(body);
              if (!config || typeof config !== 'object' || Array.isArray(config)) {
                throw new Error('Level config must be a JSON object.');
              }
              await writeFile(LEVEL_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
              response.writeHead(200, { 'Content-Type': 'application/json' });
              response.end(JSON.stringify({ ok: true, path: 'src/config/level-config.json' }));
            } catch (error) {
              response.writeHead(400, { 'Content-Type': 'application/json' });
              response.end(JSON.stringify({
                ok: false,
                error: error instanceof Error ? error.message : 'Unable to save level config.',
              }));
            }
          })();
        });
      });
    },
  };
}

function basisTranscoderAssets(): Plugin[] {
  const files = ['basis_transcoder.js', 'basis_transcoder.wasm'];
  const directory = fileURLToPath(new URL('./node_modules/three/examples/jsm/libs/basis/', import.meta.url));
  return [
    {
      name: 'playersim-basis-transcoder-dev-assets',
      apply: 'serve',
      configureServer(server) {
        server.middlewares.use('/basis', (request, response, next) => {
          const fileName = request.url?.replace(/^\//, '');
          if (!fileName || !files.includes(fileName)) {
            next();
            return;
          }
          void readFile(`${directory}/${fileName}`).then((contents) => {
            response.writeHead(200, {
              'Content-Type': fileName.endsWith('.wasm') ? 'application/wasm' : 'text/javascript',
            });
            response.end(contents);
          }).catch(next);
        });
      },
    },
    {
      name: 'playersim-basis-transcoder-build-assets',
      apply: 'build',
      async buildStart() {
        for (const fileName of files) {
          this.emitFile({
            type: 'asset',
            fileName: `basis/${fileName}`,
            source: await readFile(`${directory}/${fileName}`),
          });
        }
      },
    },
  ];
}

export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/web-playersim/' : '/',
  plugins: [levelConfigWriter(), ...basisTranscoderAssets()],
  assetsInclude: ['**/*.glb', '**/*.ktx2'],
  publicDir: 'node_modules/three/examples/jsm/libs/draco/gltf',
  server: {
    host: '127.0.0.1',
  },
}));
