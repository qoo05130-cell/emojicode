(() => {
  'use strict';

  // digit -> emoji (for display)
  const DIGIT_TO_EMOJI = ['✊', '☝️', '✌️', '🤟', '🖖', '🖐️'];

  // base codepoint -> digit. We strip variation selectors and skin tones
  // before lookup, so both ☝ and ☝️ map to 1.
  const CODEPOINT_TO_DIGIT = new Map([
    [0x270a, 0], // ✊  fist
    [0x261d, 1], // ☝  index up
    [0x270c, 2], // ✌  victory
    [0x1f91f, 3], // 🤟 love-you
    [0x1f596, 4], // 🖖 vulcan
    [0x1f590, 5], // 🖐 splayed hand
  ]);

  // Codepoints to ignore when parsing (variation selectors, ZWJ, skin tones).
  const isIgnorable = (cp) => {
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

  function digitsToByte(digits) {
    let v = 0;
    for (const d of digits) v = v * BASE + d;
    return v;
  }

  function encrypt(text) {
    if (!text) return '';
    const bytes = new TextEncoder().encode(text);
    const groups = [];
    for (const b of bytes) {
      const emojis = byteToDigits(b).map((d) => DIGIT_TO_EMOJI[d]).join('');
      groups.push(emojis);
    }
    return groups.join(' ');
  }

  function parseDigits(cipher) {
    const digits = [];
    for (const ch of cipher) {
      const cp = ch.codePointAt(0);
      if (isIgnorable(cp)) continue;
      const d = CODEPOINT_TO_DIGIT.get(cp);
      if (d !== undefined) {
        digits.push(d);
        continue;
      }
      // Treat whitespace and common separators as harmless.
      if (/\s|[|,.\-_/]/.test(ch)) continue;
      throw new Error(`不認得這個符號：「${ch}」`);
    }
    return digits;
  }

  function decrypt(cipher) {
    const digits = parseDigits(cipher);
    if (digits.length === 0) return '';
    if (digits.length % DIGITS_PER_BYTE !== 0) {
      throw new Error(
        `手勢數量不是 ${DIGITS_PER_BYTE} 的倍數（共 ${digits.length} 個），無法完整解密`
      );
    }
    const bytes = new Uint8Array(digits.length / DIGITS_PER_BYTE);
    for (let i = 0; i < bytes.length; i++) {
      const slice = digits.slice(i * DIGITS_PER_BYTE, (i + 1) * DIGITS_PER_BYTE);
      const b = digitsToByte(slice);
      if (b > 255) {
        throw new Error(`第 ${i + 1} 組手勢無法對應到合法 byte`);
      }
      bytes[i] = b;
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new Error('解出的 bytes 不是有效的 UTF-8，請檢查手勢順序');
    }
  }

  // --- DOM wiring ---
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

  document.addEventListener('DOMContentLoaded', () => {
    const plainInput = $('plain-input');
    const cipherOutput = $('cipher-output');
    const cipherInput = $('cipher-input');
    const plainOutput = $('plain-output');

    setOutput(cipherOutput, '');
    setOutput(plainOutput, '');

    $('encrypt-btn').addEventListener('click', () => {
      try {
        setOutput(cipherOutput, encrypt(plainInput.value));
      } catch (e) {
        setOutput(cipherOutput, e.message, 'error');
      }
    });

    $('decrypt-btn').addEventListener('click', () => {
      try {
        setOutput(plainOutput, decrypt(cipherInput.value));
      } catch (e) {
        setOutput(plainOutput, e.message, 'error');
      }
    });

    $('copy-cipher').addEventListener('click', async (e) => {
      const ok = await copyText(cipherOutput.textContent);
      flashButton(e.currentTarget, ok ? '已複製 ✓' : '複製失敗');
    });

    $('copy-plain').addEventListener('click', async (e) => {
      const ok = await copyText(plainOutput.textContent);
      flashButton(e.currentTarget, ok ? '已複製 ✓' : '複製失敗');
    });

    // Live encrypt as the user types — instant feedback feels nicer.
    plainInput.addEventListener('input', () => {
      try {
        setOutput(cipherOutput, encrypt(plainInput.value));
      } catch (e) {
        setOutput(cipherOutput, e.message, 'error');
      }
    });
  });
})();
