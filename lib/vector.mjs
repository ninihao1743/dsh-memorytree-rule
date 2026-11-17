// lib/vector.mjs — 离线字面向量（hashed char n-gram，非神经网络嵌入）。
//
// 诚实说明：这不是 bge/text-embedding 那种语义向量，它衡量的是「字面相近」。
// 它的价值：拼错、词序变化、长词截断、换说法时仍能召回；与 BM25 互补。
// 选择它的理由：零依赖、零模型下载、毫秒级、在中文短文本上稳定；
// 若将来接入真正的 embedding，只需替换 embed() 的实现与 DIM，存储格式不用动。
import { tokenize } from "./text.mjs";

export const VEC_DIM = 256;
export const VEC_KIND = "hash-char-ngram-v1";

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** 文本 → L2 归一化的 Float32Array(VEC_DIM)。相同文本永远得到相同向量。 */
export function embed(text) {
  const v = new Float32Array(VEC_DIM);
  for (const [term, w] of tokenize(text)) {
    const h = fnv1a(term);
    const idx = h % VEC_DIM;
    const sign = (h >>> 9) & 1 ? 1 : -1; // 带符号哈希，降低碰撞同号放大的偏差
    v[idx] += sign * w;
  }
  let norm = 0;
  for (let i = 0; i < VEC_DIM; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < VEC_DIM; i++) v[i] /= norm;
  return v;
}

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // 两边都已归一化，点积即余弦
}

export function pack(vec) {
  return Buffer.from(new Float32Array(vec).buffer);
}

export function unpack(buf) {
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Float32Array(ab);
}
