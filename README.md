<div align="center">

<img src="src/img/suspendy-guy-main.webp" alt="Suspendy Guy - The Marvellous Suspender mascot" width="120" />

# The Marvellous Suspender

**Free your memory. Suspend what you don't need.**

A free, open-source Chrome extension - no ads, no tracking.  
Based on The Great Suspender, cleaned up and actively maintained.

[![License: GPLv2](https://img.shields.io/badge/License-GPLv2-blue.svg)](LICENSE)
[![Manifest V3](https://img.shields.io/badge/Manifest-v3-brightgreen)](#build-from-source)
[![Chrome ≥ 110](https://img.shields.io/badge/Chrome-%3E%3D110-yellow?logo=googlechrome&logoColor=white)](https://go.gioxx.org/tgs)
[![Crowdin](https://img.shields.io/badge/l10n-Crowdin-2E3340?logo=crowdin&logoColor=white)](https://crowdin.com/project/tms)

</div>

---

Once installed and enabled, this extension will automatically *suspend* tabs that have not been used for a default, or user-configurable, time interval. As a result, resources such as memory and CPU that the tab was consuming are freed.

If you have suggestions or problems using the extension, please [submit a bug or a feature request](https://github.com/gioxx/MarvellousSuspender/issues/).

---

## Chrome Web Store

The Marvellous Suspender is [available via the official Chrome Web Store](https://chromewebstore.google.com/detail/the-marvellous-suspender/noogafoofpebimajpfpamcfhoaifemoa).

For more information on the permissions required by the extension, see [kb.marvellouscode.works/docs/TMS/permissions](https://kb.marvellouscode.works/docs/TMS/permissions).

---

## Install as an extension from source

> Requires **Google Chrome 110 or later** (Manifest V3).

1. Download the **[latest available version](https://github.com/gioxx/MarvellousSuspender/releases)** and unarchive to your preferred location.
2. In **Google Chrome**, navigate to `chrome://extensions/` and enable **Developer mode** (toggle in the upper right corner).
3. Click <kbd>Load unpacked extension...</kbd>.
4. Browse to the `src` directory of the unarchived folder and confirm.

The "welcome" page will open indicating successful installation.

> Be sure to unsuspend all suspended tabs before removing any other version of the extension - suspended tabs that are removed will disappear forever.

### Build from source

Dependencies: `openssl`, `npm`.

```sh
npm install
npm run generate-key
npm run build
```

Output should end with:

```
Done, without errors.
```

The extension in `.crx` format will be inside `build/crx/`. You can drag it into `chrome://extensions` to install locally.

> **"This extension is not listed in the Chrome Web Store"** - if Chrome prevents you from enabling the `.crx`, extract the `.zip` from `build/zip/`, navigate to `chrome://extensions`, click <kbd>Load unpacked extension...</kbd>, browse to the extracted folder, and confirm.

---

## Contributing

Contributions are very welcome. Feel free to submit pull requests for new features and bug fixes. For new features, please raise an issue first so we can discuss the approach - this will go a long way to ensuring your pull request is accepted.

### Localization (l10n)

Help localize the extension into your language via Crowdin: [crowdin.com/project/tms](https://crowdin.com/project/tms).  
If your language is not available, [submit a feature request](https://github.com/gioxx/MarvellousSuspender/issues/).

> [!WARNING]  
> **Only `en` (English) and `it` (Italian) are maintained directly and can be relied upon as accurate**.
> All other languages were recently brought up to date with AI assistance to close large translation gaps - the result should be functional, but has not had a native-speaker review pass.
> If you're fluent in one of these languages, **corrections and improvements via Crowdin are very welcome**.

---

## License

This work is licensed under a [GNU General Public License v2](LICENSE).

---

<div>
  <img src="src/img/suspendy-guy-lotus.webp" alt="" width="48" align="right" />
  <img src="src/img/marvellous-codeworks-logo.webp" alt="Marvellous Codeworks" height="26" align="left" /> <i>A Marvellous Codeworks project</i>
</div>
