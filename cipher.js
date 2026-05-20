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
    0x2728, // ✨ sparkles — inserted between two adjacent palms
  ]);

  const RULES = [
    {
      name: '兩個手掌之間自動冒出閃光',
      // Lookahead so 🖐️🖐️🖐️ becomes 🖐️✨🖐️✨🖐️ (every adjacent pair).
      apply: (s) => s.replace(/🖐️(?=🖐️)/g, '🖐️✨'),
    },
  ];

  function applyRules(s) {
    for (const r of RULES) s = r.apply(s);
    return s;
  }

  // ---- Shortcut codes ---------------------------------------------------
  // Compression layer. Common byte sequences in the encoded gesture stream
  // are replaced with a single emoji to keep output from ballooning. Each
  // shortcut maps one plaintext snippet to one emoji; on decrypt the emoji
  // expands back to the original gesture sequence before normal decoding.
  //
  // Targets are picked so frequencies differ across English vs Chinese text
  // (and so each emoji actually shows up somewhere). Add more by appending —
  // pick plaintexts whose bytes can't appear at non-character-boundaries in
  // valid UTF-8 (ASCII-only or whole multi-byte chars are both safe).

  const SHORTCUTS = [
    ['the', '💀'],
    ['ing', '😭'],
    ['and', '🤡'],
    ['的',   '🫠'],
    ['了',   '🥺'],
    ['是',   '🙏'],
    ['我',   '🤌'],
  ];

  // Encode each shortcut's plaintext into its raw gesture sequence (no rule
  // decoration — we replace before applyRules runs).
  const SHORTCUT_ENCODED = SHORTCUTS.map(([plain, emoji]) => {
    let g = '';
    for (const b of new TextEncoder().encode(plain)) {
      for (const d of byteToDigits(b)) g += DIGIT_TO_EMOJI[d];
    }
    return [g, emoji];
  });

  const SHORTCUT_CODEPOINTS = new Set(SHORTCUTS.map(([, e]) => e.codePointAt(0)));

  function applyShortcuts(gestureStream) {
    let s = gestureStream;
    for (const [g, e] of SHORTCUT_ENCODED) s = s.split(g).join(e);
    return s;
  }

  function expandShortcuts(cipher) {
    let s = cipher;
    for (const [g, e] of SHORTCUT_ENCODED) s = s.split(e).join(g);
    return s;
  }

  // ---- Modes -------------------------------------------------------------

  // Characters reserved by the cipher (the 6 gestures + any decoration
  // emojis + shortcut emojis). In partial modes these are always encrypted —
  // otherwise a literal 🖐️ or 💀 in the plaintext would be indistinguishable
  // from cipher output and decryption would mangle it.
  const isReservedChar = (ch) => {
    const cp = ch.codePointAt(0);
    return (
      CODEPOINT_TO_DIGIT.has(cp) ||
      DECORATION_CODEPOINTS.has(cp) ||
      SHORTCUT_CODEPOINTS.has(cp)
    );
  };

  const MODES = {
    all: {
      label: '全部加密',
      shouldEncrypt: () => true,
    },
    digits: {
      label: '只加密數字',
      shouldEncrypt: (ch) => /[0-9]/.test(ch) || isReservedChar(ch),
    },
    english: {
      label: '只加密英文',
      shouldEncrypt: (ch) => /[A-Za-z]/.test(ch) || isReservedChar(ch),
    },
  };

  function encrypt(text, mode = 'all') {
    if (!text) return '';
    const m = MODES[mode] || MODES.all;
    let out = '';
    // Iterate by grapheme-ish unit: take a base codepoint plus any trailing
    // combining marks (VS16, ZWJ, skin tones) so an emoji like 🖐️ is treated
    // as one character when checking shouldEncrypt and when encoding.
    const chars = [...text];
    for (let i = 0; i < chars.length; i++) {
      let cluster = chars[i];
      while (i + 1 < chars.length && isCombiningCodepoint(chars[i + 1].codePointAt(0))) {
        cluster += chars[++i];
      }
      out += m.shouldEncrypt(cluster) ? encodeChar(cluster) : cluster;
    }
    return applyRules(applyShortcuts(out));
  }

  // ---- Decryption -------------------------------------------------------
  // Walks the cipher one codepoint at a time. Gesture emojis accumulate into
  // a 4-digit buffer that flushes to a byte; anything else passes through as
  // a literal (after first flushing any decoded bytes as UTF-8). This makes
  // the decoder mode-agnostic: it handles all-encrypt and partial-encrypt
  // outputs with the same code path.

  function decrypt(cipher) {
    if (!cipher) return '';
    cipher = expandShortcuts(cipher);

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
