(() => {
  'use strict';

  // ---- Core encoding -----------------------------------------------------

  // digit -> emoji (used for output)
  const DIGIT_TO_EMOJI = ['✊', '☝️', '✌️', '🤟', '🖖', '🖐️'];

  // base codepoint -> digit. Variation selectors and skin tones are stripped
  // before lookup so ☝, ☝️, ☝🏼 all map to the same digit.
  const CODEPOINT_TO_DIGIT = new Map([
    [0x270a, 0], // ✊  fist
    [0x261d, 1], // ☝  index up
    [0x270c, 2], // ✌  victory
    [0x1f91f, 3], // 🤟 love-you
    [0x1f596, 4], // 🖖 vulcan
    [0x1f590, 5], // 🖐 splayed hand
  ]);

  const isCombiningCodepoint = (cp) => {
    if (cp === 0xfe0f || cp === 0xfe0e) return true; // variation selectors
    if (cp === 0x200d) return true; // zero-width joiner
    if (cp >= 0x1f3fb && cp <= 0x1f3ff) return true; // skin tone modifiers
    return false;
  };

  const BASE = 6;
  const DIGITS_PER_BYTE = 4; // 6^4 = 1296 > 256

  function byteToDigits(byte) {
    const out = new Array(DIGITS_PER_BYTE);
    for (let i = DIGITS_PER_BYTE - 1; i >= 0; i--) {
      out[i] = byte % BASE;
      byte = Math.floor(byte / BASE);
    }
    return out;
  }

  function encodeChar(ch) {
    const bytes = new TextEncoder().encode(ch);
    let s = '';
    for (const b of bytes) {
      for (const d of byteToDigits(b)) s += DIGIT_TO_EMOJI[d];
    }
    return s;
  }

  // ---- Special rules ----------------------------------------------------
  // Post-processing transformations applied after the base cipher is
  // produced. Each rule has an `apply(s) -> s` and registers any decorative
  // codepoints it inserts in DECORATION_CODEPOINTS so the decoder skips them.
  // Add new rules here.

  const DECORATION_CODEPOINTS = new Set([
    0x1f62d, // 😭 crying face — inserted between two adjacent palms
  ]);

  const RULES = [
    {
      name: '兩個手掌之間自動出現哭臉',
      // Lookahead so 🖐️🖐️🖐️ becomes 🖐️😭🖐️😭🖐️ (every adjacent pair).
      apply: (s) => s.replace(/🖐️(?=🖐️)/g, '🖐️😭'),
    },
  ];

  function applyRules(s) {
    for (const r of RULES) s = r.apply(s);
    return s;
  }

  // ---- Modes -------------------------------------------------------------

  const MODES = {
    all: { label: '全部加密', shouldEncrypt: () => true },
    digits: { label: '只加密數字', shouldEncrypt: (ch) => /[0-9]/.test(ch) },
    english: { label: '只加密英文', shouldEncrypt: (ch) => /[A-Za-z]/.test(ch) },
  };

  function encrypt(text, mode = 'all') {
    if (!text) return '';
    const { shouldEncrypt } = MODES[mode] || MODES.all;
    let out = '';
    for (const ch of text) {
      out += shouldEncrypt(ch) ? encodeChar(ch) : ch;
    }
    return applyRules(out);
  }

  // ---- Decryption -------------------------------------------------------
  // Walks the cipher one codepoint at a time. Gesture emojis accumulate into
  // a 4-digit buffer that flushes to a byte; anything else passes through as
  // a literal (after first flushing any decoded bytes as UTF-8). This makes
  // the decoder mode-agnostic: it handles all-encrypt and partial-encrypt
  // outputs with the same code path.

  function decrypt(cipher) {
    if (!cipher) return '';

    let out = '';
    let pendingBytes = [];
    let digitBuf = [];

    const flushBytes = () => {
      if (!pendingBytes.length) return;
      try {
        out += new TextDecoder('utf-8', { fatal: true }).decode(
          new Uint8Array(pendingBytes)
        );
      } catch {
        throw new Error('解出的 bytes 不是有效的 UTF-8，請檢查手勢順序');
      }
      pendingBytes = [];
    };

    for (const ch of cipher) {
      const cp = ch.codePointAt(0);
      if (isCombiningCodepoint(cp)) continue;
      if (DECORATION_CODEPOINTS.has(cp)) continue;

      const d = CODEPOINT_TO_DIGIT.get(cp);
      if (d !== undefined) {
        digitBuf.push(d);
        if (digitBuf.length === DIGITS_PER_BYTE) {
          let v = 0;
          for (const x of digitBuf) v = v * BASE + x;
          if (v > 255) {
            throw new Error('有一組手勢無法對應到合法 byte (>255)');
          }
          pendingBytes.push(v);
          digitBuf = [];
        }
        continue;
      }

      // Literal character — flush any decoded bytes first so the literal
      // appears in the right position, then emit it verbatim.
      if (digitBuf.length) {
        throw new Error(
          `手勢沒湊滿 4 個就遇到非手勢字元「${ch}」(目前 ${digitBuf.length} 個)`
        );
      }
      flushBytes();
      out += ch;
    }

    if (digitBuf.length) {
      throw new Error(
        `結尾還有 ${digitBuf.length} 個手勢沒湊滿一組 (每組需要 ${DIGITS_PER_BYTE} 個)`
      );
    }
    flushBytes();
    return out;
  }

  // ---- DOM wiring -------------------------------------------------------

  const $ = (id) => document.getElementById(id);

  function setOutput(node, text, kind = 'normal') {
    node.classList.remove('error', 'placeholder');
    if (kind === 'error') {
      node.classList.add('error');
      node.textContent = text;
    } else if (!text) {
      node.classList.add('placeholder');
      node.textContent = '（結果會顯示在這裡）';
    } else {
      node.textContent = text;
    }
  }

  async function copyText(text) {
    if (!text) return false;
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }

  function flashButton(btn, label) {
    const original = btn.textContent;
    btn.textContent = label;
    btn.disabled = true;
    setTimeout(() => {
      btn.textContent = original;
      btn.disabled = false;
    }, 1200);
  }

  function wireEncryptPanel(mode) {
    const input = $(`plain-input-${mode}`);
    const output = $(`cipher-output-${mode}`);
    const btn = $(`encrypt-btn-${mode}`);
    const copyBtn = $(`copy-cipher-${mode}`);

    const run = () => {
      try {
        setOutput(output, encrypt(input.value, mode));
      } catch (e) {
        setOutput(output, e.message, 'error');
      }
    };

    setOutput(output, '');
    btn.addEventListener('click', run);
    input.addEventListener('input', run);
    copyBtn.addEventListener('click', async (e) => {
      const ok = await copyText(output.textContent);
      flashButton(e.currentTarget, ok ? '已複製 ✓' : '複製失敗');
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    wireEncryptPanel('all');
    wireEncryptPanel('digits');
    wireEncryptPanel('english');

    const cipherInput = $('cipher-input');
    const plainOutput = $('plain-output');
    setOutput(plainOutput, '');

    const runDecrypt = () => {
      try {
        setOutput(plainOutput, decrypt(cipherInput.value));
      } catch (e) {
        setOutput(plainOutput, e.message, 'error');
      }
    };

    $('decrypt-btn').addEventListener('click', runDecrypt);
    cipherInput.addEventListener('input', runDecrypt);

    $('copy-plain').addEventListener('click', async (e) => {
      const ok = await copyText(plainOutput.textContent);
      flashButton(e.currentTarget, ok ? '已複製 ✓' : '複製失敗');
    });
  });
})();
