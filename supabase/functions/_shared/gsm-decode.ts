/**
 * MS-GSM 6.10 decoder for WAV files (codec 0x0031).
 * Ported from the canonical libgsm C implementation (Jutta Degener & Carsten Bormann, TU Berlin).
 *
 * MS-GSM packs 2 standard GSM frames (each 33 bytes → 160 samples) into
 * one 65-byte WAV block → 320 samples at 8kHz.
 */

// ── Decoder state ──────────────────────────────────────────────────────
interface GsmState {
  dp0: Float64Array;  // 280 long-term predictor buffer
  u: Float64Array;    // 8 short-term filter state
  LARpp: [Float64Array, Float64Array]; // previous/current LAR
  j: number;          // toggle index for LARpp
  nrp: number;        // LTP lag memory
}

function newState(): GsmState {
  return {
    dp0: new Float64Array(280),
    u: new Float64Array(8),
    LARpp: [new Float64Array(8), new Float64Array(8)],
    j: 0,
    nrp: 40,
  };
}

// ── Clamp helpers ──────────────────────────────────────────────────────
const SAT = (x: number) => (x > 32767 ? 32767 : x < -32768 ? -32768 : x);
const SASR = (x: number, by: number) => (x >= 0 ? x >> by : ~((~x) >> by));

// ── Tables (from GSM 06.10 spec) ──────────────────────────────────────
const FAC = [18431, 20479, 22527, 24575, 26623, 28671, 30719, 32767];
const QLB = [3277, 11469, 21299, 32767];

// ── Decode LAR coefficients (Table 3.6) ───────────────────────────────
function decodeLAR(LARc: number[], LARpp: Float64Array): void {
  const MIC  = [-32, -32, -16, -16, -8, -8, -4, -4];
  const B    = [0, 0, 2048, -2560, 94, -1792, -341, -1144];
  for (let i = 0; i < 8; i++) {
    let temp = SAT((LARc[i] + MIC[i]) << 10);
    temp = SAT(temp + B[i]);
    temp = SAT(temp << 1);
    LARpp[i] = SASR(temp * FAC[i], 15);
  }
}

// ── Coefficients interpolation for short-term filter ──────────────────
function interpolate(
  LARpp_prev: Float64Array, LARpp_curr: Float64Array,
  subframe: number, out: Float64Array
): void {
  for (let i = 0; i < 8; i++) {
    switch (subframe) {
      case 0: out[i] = SASR(LARpp_prev[i], 2) + SASR(LARpp_curr[i], 2) + SASR(LARpp_prev[i], 1); break;
      case 1: out[i] = SASR(LARpp_prev[i], 1) + SASR(LARpp_curr[i], 1); break;
      case 2: out[i] = SASR(LARpp_prev[i], 2) + SASR(LARpp_curr[i], 2) + SASR(LARpp_curr[i], 1); break;
      case 3: out[i] = LARpp_curr[i]; break;
    }
  }
}

// ── Convert LARp to reflection coefficients ───────────────────────────
function larpToRp(LARp: Float64Array): Float64Array {
  const rp = new Float64Array(8);
  for (let i = 0; i < 8; i++) {
    const temp = Math.abs(LARp[i]);
    let out: number;
    if (temp < 11059) out = temp << 1;
    else if (temp < 20070) out = temp + 11059;
    else out = SAT((temp >> 2) + 26112);
    rp[i] = LARp[i] < 0 ? -out : out;
  }
  return rp;
}

// ── Short-term synthesis filter ───────────────────────────────────────
function shortTermSynthesis(
  rp: Float64Array, wt: Float64Array, wtOff: number,
  s: Float64Array, sOff: number, u: Float64Array
): void {
  for (let k = 0; k < 40; k++) {
    let sri = wt[wtOff + k];
    for (let i = 7; i >= 0; i--) {
      sri = SAT(sri - SASR(rp[i] * u[i], 15));
      u[i + 1 < 8 ? i + 1 : 7] = SAT(u[i] + SASR(rp[i] * sri, 15));
    }
    u[0] = sri;
    s[sOff + k] = sri;
  }
}

// ── APCM inverse quantization ─────────────────────────────────────────
function apcmInvQuantize(xMc: number[], xmaxc: number, xMcp: Float64Array): void {
  const exp = (xmaxc >> 3) & 0x0F;
  const mant = xmaxc & 0x07;
  const mantTab = [
    0, 1 << (exp + 5), 1 << (exp + 5),
    mant === 0 ? (1 << (exp + 5)) - (1 << (exp + 2))
    : (((mant << 3) | 4) << (exp + 2))
  ];
  const itest = exp <= 2 ? (mant + 1) >> (3 - exp) : mant << (exp - 3) + 4;

  // Simplified: direct decode
  let temp1: number;
  if (mant === 0) {
    temp1 = exp > 0 ? 1 << (exp - 1) : 0;
  } else {
    temp1 = (mant << 3) << Math.max(0, exp - 4);
  }

  // Full decode per spec section 3.1.17
  const temp2 = SASR(QLB[mant >= 4 ? 3 : mant], 1);
  const shift = exp + 1;

  for (let i = 0; i < 13; i++) {
    let temp3 = (xMc[i] << 1) - 7;    // STEP 1: deq
    temp3 = temp3 === 0 ? 0 : (temp3 < 0 ? SASR(-temp3 * temp2, 15) * -1 : SASR(temp3 * temp2, 15));
    xMcp[i] = SAT(temp3 << shift);
  }
}

// ── RPE grid positioning ──────────────────────────────────────────────
function rpeGridPos(Mc: number, xMcp: Float64Array, ep: Float64Array): void {
  ep.fill(0);
  for (let i = 0; i < 13; i++) {
    ep[Mc + i * 3] = xMcp[i];
  }
}

// ── Long-term synthesis ───────────────────────────────────────────────
function longTermSynth(
  Nc: number, bc: number, ep: Float64Array,
  dp: Float64Array, dpOff: number
): void {
  const brp = QLB[bc > 3 ? 3 : bc];
  for (let k = 0; k < 40; k++) {
    const prevIdx = dpOff + k - Nc;
    const dpPrev = (prevIdx >= 0 && prevIdx < dp.length) ? dp[prevIdx] : 0;
    dp[dpOff + k] = SAT(ep[k] + SASR(brp * dpPrev, 14));
  }
}

// ── Unpack MS-GSM block ───────────────────────────────────────────────
// 65 bytes → 2 frames, each with: LARc[8], 4×{Nc,bc,Mc,xmaxc,xMc[13]}
interface GsmFrame {
  LARc: number[];
  Nc: number[];
  bc: number[];
  Mc: number[];
  xmaxc: number[];
  xMc: number[][];
}

function unpackMsGsm(data: Uint8Array, off: number): [GsmFrame, GsmFrame] {
  const d = data;
  let c = off;

  // Frame 1 (bytes 0..32 of the 65-byte block)
  const f1: GsmFrame = {
    LARc: new Array(8), Nc: new Array(4), bc: new Array(4),
    Mc: new Array(4), xmaxc: new Array(4), xMc: [[], [], [], []],
  };

  // LAR coefficients (packed in first ~4.5 bytes)
  f1.LARc[0] = (d[c] & 0x3F);
  f1.LARc[1] = ((d[c] >> 6) & 0x03) | ((d[c+1] & 0x0F) << 2);
  f1.LARc[2] = ((d[c+1] >> 4) & 0x0F) | ((d[c+2] & 0x01) << 4);
  f1.LARc[3] = (d[c+2] >> 1) & 0x1F;
  f1.LARc[4] = ((d[c+2] >> 6) & 0x03) | ((d[c+3] & 0x03) << 2);
  f1.LARc[5] = (d[c+3] >> 2) & 0x0F;
  f1.LARc[6] = ((d[c+3] >> 6) & 0x03) | ((d[c+4] & 0x01) << 2);
  f1.LARc[7] = (d[c+4] >> 1) & 0x07;

  // 4 subframes for frame 1
  let bp = c + 4; // byte pointer
  let bi = 4;     // bit index within byte (after LARc takes 36 bits = 4 bytes + 4 bits)

  function getBits(n: number): number {
    let val = 0;
    for (let i = 0; i < n; i++) {
      val |= ((d[bp] >> bi) & 1) << i;
      bi++;
      if (bi >= 8) { bi = 0; bp++; }
    }
    return val;
  }

  for (let s = 0; s < 4; s++) {
    f1.Nc[s] = getBits(7);
    f1.bc[s] = getBits(2);
    f1.Mc[s] = getBits(2);
    f1.xmaxc[s] = getBits(6);
    f1.xMc[s] = [];
    for (let i = 0; i < 13; i++) {
      f1.xMc[s].push(getBits(3));
    }
  }

  // Frame 2 starts at byte 33 (0-indexed from block start)
  const f2: GsmFrame = {
    LARc: new Array(8), Nc: new Array(4), bc: new Array(4),
    Mc: new Array(4), xmaxc: new Array(4), xMc: [[], [], [], []],
  };

  // Reset to byte 33
  bp = c + 32;
  bi = 4; // frame 2 LAR starts at bit 4 of byte 32

  f2.LARc[0] = getBits(6);
  f2.LARc[1] = getBits(6);
  f2.LARc[2] = getBits(5);
  f2.LARc[3] = getBits(5);
  f2.LARc[4] = getBits(4);
  f2.LARc[5] = getBits(4);
  f2.LARc[6] = getBits(3);
  f2.LARc[7] = getBits(3);

  for (let s = 0; s < 4; s++) {
    f2.Nc[s] = getBits(7);
    f2.bc[s] = getBits(2);
    f2.Mc[s] = getBits(2);
    f2.xmaxc[s] = getBits(6);
    f2.xMc[s] = [];
    for (let i = 0; i < 13; i++) {
      f2.xMc[s].push(getBits(3));
    }
  }

  return [f1, f2];
}

// ── Decode one GSM frame (160 samples) ────────────────────────────────
function decodeFrame(frame: GsmFrame, state: GsmState, out: Float64Array, outOff: number): void {
  const j = state.j;
  const jPrev = 1 - j;
  state.j = jPrev;

  // Decode LARs
  decodeLAR(frame.LARc, state.LARpp[j]);

  // Clamp Nc values
  for (let s = 0; s < 4; s++) {
    if (frame.Nc[s] < 40) frame.Nc[s] = 40;
    if (frame.Nc[s] > 120) frame.Nc[s] = 120;
  }

  // Working buffers
  const wt = new Float64Array(160); // reconstructed signal before short-term
  const ep = new Float64Array(40);
  const xMcp = new Float64Array(13);

  const dpOff = 120; // offset into dp0 where current frame starts

  for (let s = 0; s < 4; s++) {
    // APCM inverse quantization
    apcmInvQuantize(frame.xMc[s], frame.xmaxc[s], xMcp);

    // RPE grid positioning
    rpeGridPos(frame.Mc[s], xMcp, ep);

    // Long-term synthesis (writes to state.dp0)
    longTermSynth(frame.Nc[s], frame.bc[s], ep, state.dp0, dpOff + s * 40);

    // Copy to wt for short-term synthesis
    for (let k = 0; k < 40; k++) {
      wt[s * 40 + k] = state.dp0[dpOff + s * 40 + k];
    }
  }

  // Short-term synthesis filter (4 subframes with interpolated coefficients)
  const LARp = new Float64Array(8);
  for (let s = 0; s < 4; s++) {
    interpolate(state.LARpp[jPrev], state.LARpp[j], s, LARp);
    const rp = larpToRp(LARp);
    shortTermSynthesis(rp, wt, s * 40, out, outOff + s * 40, state.u);
  }

  // Shift dp0 buffer: move last 120 samples to beginning
  for (let i = 0; i < 120; i++) {
    state.dp0[i] = state.dp0[i + 160];
  }
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Decode an MS-GSM WAV file to raw PCM samples.
 */
export function decodeGsmWav(wavBuffer: ArrayBuffer): {
  sampleRate: number;
  samples: Int16Array;
} {
  const view = new DataView(wavBuffer);
  const data = new Uint8Array(wavBuffer);

  const formatCode = view.getUint16(20, true);
  if (formatCode !== 0x0031) {
    throw new Error(`Not GSM WAV (format=0x${formatCode.toString(16)})`);
  }

  const sampleRate = view.getUint32(24, true);
  const blockAlign = view.getUint16(32, true);

  // Find data chunk
  let offset = 12;
  let dataSize = 0;
  while (offset < wavBuffer.byteLength - 8) {
    const id = String.fromCharCode(data[offset], data[offset+1], data[offset+2], data[offset+3]);
    const sz = view.getUint32(offset + 4, true);
    if (id === "data") { offset += 8; dataSize = sz; break; }
    offset += 8 + sz;
  }

  const numBlocks = Math.floor(dataSize / blockAlign);
  const floatSamples = new Float64Array(numBlocks * 320);
  const state = newState();

  for (let b = 0; b < numBlocks; b++) {
    const [f1, f2] = unpackMsGsm(data, offset + b * blockAlign);
    decodeFrame(f1, state, floatSamples, b * 320);
    decodeFrame(f2, state, floatSamples, b * 320 + 160);
  }

  // Convert to Int16
  const samples = new Int16Array(floatSamples.length);
  for (let i = 0; i < floatSamples.length; i++) {
    samples[i] = SAT(Math.round(floatSamples[i]));
  }

  return { sampleRate, samples };
}

/**
 * Create a standard PCM WAV file from samples.
 */
export function createPcmWav(samples: Int16Array, sampleRate: number): Uint8Array {
  const dataSize = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const v = new DataView(buffer);
  const out = new Uint8Array(buffer);

  // RIFF header
  out.set([0x52,0x49,0x46,0x46], 0); // "RIFF"
  v.setUint32(4, 36 + dataSize, true);
  out.set([0x57,0x41,0x56,0x45], 8); // "WAVE"

  // fmt chunk (PCM)
  out.set([0x66,0x6d,0x74,0x20], 12); // "fmt "
  v.setUint32(16, 16, true);   // chunk size
  v.setUint16(20, 1, true);    // PCM format
  v.setUint16(22, 1, true);    // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); // byte rate
  v.setUint16(32, 2, true);    // block align
  v.setUint16(34, 16, true);   // bits per sample

  // data chunk
  out.set([0x64,0x61,0x74,0x61], 36); // "data"
  v.setUint32(40, dataSize, true);

  // Write PCM samples
  for (let i = 0; i < samples.length; i++) {
    v.setInt16(44 + i * 2, samples[i], true);
  }

  return new Uint8Array(buffer);
}
