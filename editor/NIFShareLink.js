/**
 * NIFShareLink — Generate & Store Companion Share URLs
 * © Fumoca Technologies · fumoca.co.za
 *
 * When a presentation video is exported, the creator gets two things:
 *   1. The MP4 to drop into their timeline
 *   2. A share URL pointing to the live interactive NIF
 *
 * This module generates that URL, saves it to the presentation record,
 * and produces a short link + embed snippet for every distribution channel.
 *
 * Share URL formats:
 *   Standard:   https://fumoca.co.za/v/{nifId}
 *   With preset: https://fumoca.co.za/v/{nifId}?from=presentation&pid={presentationId}
 *   Embed:      <div data-nif-id="{nifId}" ...></div><script ...>
 *   QR:         generated as SVG inline (no third-party API needed)
 *
 * The `from=presentation` param lets the viewer load in a matching style
 * (camera pre-positioned to match the video's starting frame).
 */

export class NIFShareLink {
  /**
   * @param {object} opts
   *   nifId  string
   *   token  string
   *   api    string
   */
  constructor(opts = {}) {
    this._nifId = opts.nifId;
    this._token = opts.token;
    this._api   = opts.api ?? 'https://fumoca.co.za/api';
    this._base  = 'https://fumoca.co.za';
  }

  /**
   * Generate + persist share link for a presentation.
   * @param {string} presentationId
   * @returns {Promise<string>} the share URL
   */
  async generate(presentationId) {
    const url = presentationId
      ? `${this._base}/v/${this._nifId}?from=presentation&pid=${presentationId}`
      : `${this._base}/v/${this._nifId}`;

    // Persist on the presentation record
    if (presentationId) {
      await fetch(`${this._api}/presentations/${presentationId}`, {
        method:  'PATCH',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${this._token}`,
        },
        body: JSON.stringify({ shareUrl: url }),
      }).catch(() => {});
    }

    return url;
  }

  /**
   * Build embed code snippet for the NIF viewer.
   * @param {string} licenseKey  — optional, for B2B embedding
   * @returns {string} HTML snippet
   */
  getEmbedCode(licenseKey = 'YOUR_LICENSE_KEY') {
    return (
      `<div data-nif-id="${this._nifId}" ` +
      `data-nif-license="${licenseKey}" ` +
      `style="width:100%;aspect-ratio:16/9"></div>\n` +
      `<script src="${this._base}/viewer/nif-viewer.min.js"><\/script>`
    );
  }

  /**
   * Build a minimal QR code SVG pointing at shareUrl.
   * Uses a pure-JS QR library loaded from CDN on demand.
   * @param {string} shareUrl
   * @returns {Promise<string>} SVG string
   */
  async getQRSvg(shareUrl) {
    if (!window.QRCode) {
      await _loadScript('https://cdn.jsdelivr.net/npm/qrcode/build/qrcode.min.js');
    }
    return new Promise((res, rej) => {
      window.QRCode.toString(shareUrl, { type: 'svg', width: 256, margin: 1 }, (err, svg) => {
        if (err) rej(err); else res(svg);
      });
    });
  }

  /**
   * Get all share channel links as a structured object.
   * @param {string} shareUrl
   * @returns {object}
   */
  getChannels(shareUrl) {
    const encoded = encodeURIComponent(shareUrl);
    const text    = encodeURIComponent(`Check out this interactive 3D scene on Fumoca → ${shareUrl}`);
    return {
      direct:    shareUrl,
      youtube:   shareUrl,  // paste in description + pinned comment
      tiktok:    shareUrl,  // paste in bio link (link-in-bio tools)
      instagram: shareUrl,  // bio link
      twitter:   `https://twitter.com/intent/tweet?url=${encoded}&text=${text}`,
      whatsapp:  `https://wa.me/?text=${text}`,
      linkedin:  `https://www.linkedin.com/sharing/share-offsite/?url=${encoded}`,
      embed:     this.getEmbedCode(),
    };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = rej;
    document.head.appendChild(s);
  });
}
