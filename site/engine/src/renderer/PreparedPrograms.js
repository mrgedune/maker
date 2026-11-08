import * as source from './ShaderSources.js';

const definitions = {
  geomProgram: ['geomVS', 'geomFS'], entityProgram: ['entityVS', 'entityFS'],
  lightProgram: ['lightVS', 'lightFS'], surfaceProgram: ['surfaceVS', 'surfaceFS'],
  particleProgram: ['particleVS', 'particleFS'], asciiProgram: ['asciiVS', 'asciiFS'],
  cellProgram: ['cellVS', 'cellFS'], glyphProgram: ['glyphVS', 'glyphFS'],
  bloomPrefilterProgram: ['bloomVS', 'bloomPrefilterFS'], bloomBlurProgram: ['bloomVS', 'bloomBlurFS'],
  shadowGeomProgram: ['shadowGeomVS', 'shadowGeomFS'], shadowEntityProgram: ['shadowEntityVS', 'shadowEntityFS'],
};
const prepared = new WeakMap();
const preparing = new WeakSet();

/** Transfer already-linked programs to the renderer using this exact context. */
export function takePreparedPrograms(gl) {
  const batch = prepared.get(gl);
  if (!batch) return null;
  prepared.delete(gl); batch.taken = true;
  return batch.programs;
}

/** Compile on the destination context without synchronous compile-status queries.
 * KHR completion queries do not block; browsers without it yield between links.
 * No uniforms or LINK_STATUS are queried until that program has completed.
 */
export async function preparePrograms(gl, { signal, wait = () => new Promise(resolve => setTimeout(resolve, 16)),
  now = () => performance.now(), timeout = 15000 } = {}) {
  if (prepared.has(gl) || preparing.has(gl)) throw new Error('Graphics programs are already being prepared for this context.');
  preparing.add(gl);
  const batch = { programs: {}, shaders: [], taken: false }, deadline = now() + timeout;
  let disposed = false;
  function dispose() {
    if (disposed || batch.taken) return;
    disposed = true;
    if (prepared.get(gl) === batch) prepared.delete(gl);
    for (const program of Object.values(batch.programs)) gl.deleteProgram(program);
    for (const shader of batch.shaders) gl.deleteShader(shader);
    batch.shaders.length = 0;
  }
  function check() {
    if (signal?.aborted) throw new Error('Graphics preparation cancelled.');
    if (gl.isContextLost()) throw new Error('Graphics context lost during preparation.');
    if (now() >= deadline) throw new Error('Graphics preparation timed out. Reload to retry.');
  }
  try {
    check();
    const parallel = gl.getExtension('KHR_parallel_shader_compile');
    for (const [name, names] of Object.entries(definitions)) {
      const program = gl.createProgram();
      if (!program) throw new Error('Unable to allocate a graphics program.');
      batch.programs[name] = program;
      for (let i = 0; i < names.length; i++) {
        const shader = gl.createShader(i ? gl.FRAGMENT_SHADER : gl.VERTEX_SHADER);
        if (!shader) throw new Error('Unable to allocate a graphics shader.');
        batch.shaders.push(shader);
        gl.shaderSource(shader, source[names[i]]); gl.compileShader(shader); gl.attachShader(program, shader);
      }
      gl.linkProgram(program);
    }
    // All programs are submitted before waiting; never serialize twelve driver stalls.
    const pending = Object.values(batch.programs);
    while (pending.length) {
      await wait(); check();
      for (let i = pending.length - 1; i >= 0; i--) {
        const program = pending[i];
        if (parallel && !gl.getProgramParameter(program, parallel.COMPLETION_STATUS_KHR)) continue;
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
          throw new Error(`Graphics program link failed: ${String(gl.getProgramInfoLog(program) || 'Unknown error').slice(0, 4096)}`);
        }
        pending.splice(i, 1);
        if (!parallel) break;
      }
    }
    for (const shader of batch.shaders) gl.deleteShader(shader);
    batch.shaders.length = 0;
    prepared.set(gl, batch);
    return dispose;
  } catch (error) { dispose(); throw error; }
  finally { preparing.delete(gl); }
}
