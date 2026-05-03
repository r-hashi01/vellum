# DOM → PDF ツール 設計プラン (案D: Hybrid)

> 別 npm パッケージとして切り出すことを前提に書く。
> Dify-Deck-Template / astlide には依存しない汎用ツールとして設計する。

仮称: `vellum` (TBD — 命名は要検討)

---

## 1. ゴール / 非ゴール

### ゴール
- DOM 上にレンダリング済みの任意のページ要素群を、**ブラウザ内のみで** 高品質 PDF に変換する。
- 文字は **PDF テキストオブジェクト** として埋め込み、選択・コピー・検索可能にする。
- 背景・装飾・SVG・グラデ・影・filter は **ラスタとして焼き込み**、視覚再現を担保する。
- 部品やレイアウトコンポーネントを追加しても **ツール側の変更不要**。
- サーバー不要 — Cloudflare Pages のような静的ホスティング上で動く。

### 非ゴール
- `<canvas>` 内のテキスト抽出 (canvas はピクセルしか残らないため不可能)。
- 印刷用紙サイズへの自動レイアウト (用途はスライドや固定サイズ DOM に限定)。
- ブラウザ無し環境 (Node / Worker) での動作 (将来検討)。
- インタラクティブ要素 (ホバー・アニメ) の保存。

---

## 2. 設計の中核

```
ページ DOM ─┬─(1) テキストを透明化して全体ラスタ化 ─→ JPEG (背景/SVG/影/グラデ全部入り、文字なし)
           └─(2) Range API でテキスト行ボックスを抽出 ─→ vector text spans
                                                         ↓
                            PDF: JPEG を全面に敷く → 上にベクタテキストを描く
```

中核トリック: **「ラスタを撮る瞬間だけ全テキストを `color: transparent`」** することで、JPEG にはテキストが写らない。後から本物の PDF テキストを上に重ねる。

### 失敗モードの哲学
| 失敗ケース | 振る舞い |
|---|---|
| 未対応の CSS 機能 (filter, mix-blend-mode, mask…) | ラスタが自動で吸収 → 視覚的に問題なし |
| Walker がテキストを拾い損ねた | ラスタにはテキストが残る (透明化されなかった等) → 見えるので気づける |
| canvas 内コンテンツ | ラスタとしては表示される、テキスト選択だけ不可 (許容) |
| フォントが埋め込めなかった | 標準フォントへフォールバック、ラスタ側は元フォントが残る |

**全失敗が「見える劣化」であり、「サイレント・コンテンツ消失」が起きない**。

---

## 3. パッケージ構成

```
@vellum/core            # Walker + Rasterizer + PDF Emitter (browser, framework-agnostic)
@vellum/validator       # 静的検証 (canvas 禁止 / 警告対象 CSS 検出) — 任意
@vellum/react           # <VellumButton pages={...} /> など UI ヘルパー — 任意
@vellum/astro           # Astro integration — 任意
```

依存:
- `pdf-lib` — PDF 生成
- `fontkit` — フォントサブセット化
- `html-to-image` — raster 撮影 (v1 では流用、将来 `<foreignObject>` 内製版に差し替え可能なインターフェイスにしておく)

---

## 4. 公開 API (草案)

### 最小 API
```ts
import { domToPdf } from '@vellum/core'

const blob = await domToPdf({
  pages: document.querySelectorAll<HTMLElement>('.slide-page'),
  source: { width: 1920, height: 1080 },        // DOM 上の論理サイズ
  output: { width: 960, height: 540, unit: 'pt' }, // PDF ページサイズ
  rasterFormat: 'jpeg',                          // 'jpeg' | 'png'
  jpegQuality: 0.85,
  onProgress: (i, total) => {},
})
```

### 拡張オプション
```ts
{
  fonts: 'auto' | { src: string, family: string }[],   // 'auto' = 使用中の @font-face を自動検出 (Google Fonts のみ自動取得)
  preserveTextDecorations: {
    textShadow?: boolean,    // default: false (落とす)。true でラスタに焼き込む
    textStroke?: boolean,    // default: false
  },
  textExtraction: {
    skipSelector?: string,                   // 例: '[data-no-text]'
    treatAsImage?: string,                   // 例: 'canvas, video' — テキスト抽出対象から外す
  },
  selfCheck: { enabled: true, threshold: 0.02 }, // 後述 (Phase 3)
  rasterizer?: Rasterizer,                       // 既定: html-to-image アダプタ。差し替え可能
  hooks: {
    beforeCapture?: (page: HTMLElement) => void | Promise<void>,
    afterCapture?: (page: HTMLElement) => void | Promise<void>,
  },
}
```

---

## 5. 内部処理 (per page)

### 5.1 Capture phase
1. in-place で style を書き換え → 復元 (元 DOM を汚さない設計だが、パフォーマンス優先のため clone は v1 では避ける)
2. テキスト透明化用 stylesheet 注入:
   ```css
   * { color: transparent !important; -webkit-text-stroke-color: transparent !important; }
   /* preserveTextDecorations.textShadow = false の場合のみ追加 */
   * { text-shadow: none !important; }
   ```
   - `::before` / `::after` の `content` テキストも対象
   - SVG `<text>` の `fill` も透明化 (別ルール)
   - `preserveTextDecorations` オプションで text-shadow / text-stroke を残すか選択可能
3. `await document.fonts.ready` + `requestAnimationFrame()` × 2
4. ラスタ化 (Rasterizer インターフェイス経由):
   - **v1**: `html-to-image` の `toJpeg` / `toPng` をラップしたアダプタを既定実装に
   - **将来**: `XMLSerializer` + `<svg><foreignObject>HTML</foreignObject></svg>` の内製版に差し替え可能
   - 出力: Blob (JPEG or PNG)
5. テキスト透明化を解除

### 5.2 Walk phase (テキスト抽出)
**(1) と並行可能** — Capture 用の clone とは別に元 DOM を読む。
```ts
const walker = document.createTreeWalker(page, NodeFilter.SHOW_TEXT, {
  acceptNode(node) {
    const el = node.parentElement
    if (!el) return NodeFilter.FILTER_REJECT
    if (el.closest(skipSelector)) return NodeFilter.FILTER_REJECT
    if (el.closest(treatAsImage)) return NodeFilter.FILTER_REJECT  // canvas など
    if (getComputedStyle(el).visibility === 'hidden') return NodeFilter.FILTER_REJECT
    return NodeFilter.FILTER_ACCEPT
  }
})

const spans: TextSpan[] = []
let node: Text | null
while ((node = walker.nextNode() as Text | null)) {
  const range = document.createRange()
  range.selectNodeContents(node)
  const cs = getComputedStyle(node.parentElement!)
  for (const rect of range.getClientRects()) {
    spans.push({
      text: extractTextForRect(node, range, rect),  // 行ごとに分割
      x: rect.x, y: rect.y, w: rect.width, h: rect.height,
      fontFamily: cs.fontFamily,
      fontSize: parseFloat(cs.fontSize),
      fontWeight: parseInt(cs.fontWeight),
      fontStyle: cs.fontStyle,
      color: parseColor(cs.color),
      letterSpacing: parseFloat(cs.letterSpacing) || 0,
      direction: cs.direction,
      writingMode: cs.writingMode,
    })
  }
}
```

注意点:
- `getClientRects()` は **行ボックスごとに 1 つの DOMRect** を返す。複数行のテキストはここで自然に分かれる。
- 各 rect に対応する文字列の切り出しは別途必要 (Range の文字オフセット → rect マッピングを `Range.getBoundingClientRect()` を細分化して特定)。
- `::before` / `::after` の擬似要素テキストは `getComputedStyle(el, '::before').content` で読み、要素の前後に擬似 Range を作って配置する。

### 5.3 Build phase (PDF)
```ts
const pdf = await PDFDocument.create()
const fontResources = await prepareFontSubsets(spans)  // 後述
for (const { raster, spans } of perPage) {
  const page = pdf.addPage([outputWidth, outputHeight])
  const img = await pdf.embedJpg(rasterBytes)
  page.drawImage(img, { x: 0, y: 0, width: outputWidth, height: outputHeight })
  for (const s of spans) {
    const { font, scale } = pickFont(fontResources, s)
    page.drawText(s.text, {
      x: s.x * scaleX,
      y: outputHeight - (s.y + s.h) * scaleY,  // PDF 座標系は左下原点
      size: s.fontSize * scale,
      font,
      color: rgb(s.color.r, s.color.g, s.color.b),
      opacity: s.color.a,
    })
  }
}
return await pdf.save()
```

座標変換は `scaleX = outputWidth / sourceWidth`, `scaleY = outputHeight / sourceHeight` で固定。**スケール係数の混入箇所はここ 1 箇所だけ** にする (現行実装の混乱原因を解消)。

---

## 6. 制約と Validator

### ハード禁止 (Validator がエラー出力)
- `<canvas>` 内コンテンツでテキスト依存があるもの → SVG 又は HTML に置き換え推奨
- `<video>` のフレーム埋め込みは raster のみ

### ソフト警告 (動くが品質保証外)
- `mix-blend-mode`, `backdrop-filter`, `filter: blur()` — ラスタには出るがベクタ要素と混ざらない
- `position: sticky` — 1 ページ DOM 想定なので意味を持たない
- 3D `transform` — ラスタには出る

### Validator の動かし方
- ビルド時: AST 走査で MDX/HTML 内の `<canvas>` を検出 → エラー
- 実行時: `domToPdf` 呼び出し前に `validate(pages)` を実行可能
- IDE/CI どちらでも使える

---

## 7. フォント戦略

PDF テキストの正確な再現には **フォントの埋め込み** が必須。

### v1 方針: Google Fonts Proxy のみ
**v1 ではフォント取得元を Google Fonts に限定する**。任意ホスト対応は後続。

1. Walk phase で集まった spans から使用フォント (family × weight × style) と使用文字 (Set<string>) を集計
2. ページ内の `@font-face` ルールから `src: url(...)` を取得
3. URL のホストを判定:
   - `fonts.gstatic.com` / `fonts.googleapis.com` → 取得対象 (Google Fonts proxy 経由)
   - それ以外 → スキップして警告 → 標準 14 フォントへフォールバック
4. `fontkit` でグリフサブセット化 (使用文字のみ含む)
5. `pdf.embedFont(subsetBytes, { subset: true })`

### Google Fonts Proxy
- パッケージに同梱の薄い proxy URL を経由する (CORS 突破用)。 例: `https://fonts.vellum.dev/...`
- もしくは利用者側で proxy を立てて URL を渡せる API も用意 (`googleFontsProxy: 'https://my-proxy/...'`)
- 既知の Google Fonts CSS API は CORS が緩いので直接 fetch も検証する (要実測)

### フォールバック規則
- 同 family の異 weight が見つからない場合: **synthetic bold (描画時 strokeWidth 増加)** で代替
- `font-family` チェーンを左から試行、全滅したら標準フォント
- 日本語: PDF 標準にはないので Noto Sans JP (Google Fonts) を既定フォールバックとして同梱推奨

### 制約 (v1)
- **Google Fonts 以外の `@font-face` は埋め込まない**。ラスタ側にはフォント通り写るのでドキュメント上は読めるが、テキスト選択時のコピー結果は標準フォントで描画される
- `@font-face` が無いシステムフォント (例: `font-family: system-ui`) は **再現不能** — フォールバック警告を出す
- 縦書き (`writing-mode: vertical-rl`) は v1 では非対応 (vertical のフラグだけ立てる)
- **Shadow DOM / iframe 内のフォント・テキストは v1 では非対応**

---

## 8. 自己チェック (Phase 3)

PDF 生成後に **自分で検算** する仕組み:

1. 生成した PDF の各ページを `pdf.js` でクライアント側ラスタ化
2. Capture phase の元ラスタと **画素単位 diff** (差分平均 / SSIM)
3. 閾値を超えたページがあれば `result.warnings` に "page N: visual diff = 5.3%" と記録
4. UI 側でトースト: 「⚠ slide 3 でレンダリング差分が検出されました」

これで「サイレント失敗」を **検出可能な失敗** に格上げする。

---

## 9. マイルストーン

### Phase 0: PoC (1〜2 日)
- 単一ページ・基本 CSS のみ (text + background-color + img)
- 透明化トリックの実証
- Range API → 座標 → PDF テキスト配置の精度確認
- 各段 (capture / walk / emit) の所要時間を計測してログ出力する `onProgress` 互換のプリミティブを入れる — 後段の最適化判断 (WASM / Worker / どちらでもないか) を実測ベースで下すため
- ✅ Exit 条件:
  1. 1 枚の simple slide が画面と PDF で見分けつかない
  2. 3 枚の slide で `capture / walk / emit` の所要時間が出力され、ボトルネックがどこかが特定できる

### Phase 1: MVP (1 週)
- 複数ページ対応
- フォント自動検出 + 標準 14 フォントへの fallback (subsetting なし)
- 公開 API (`@vellum/core`) を npm publish 可能な形に
- ✅ Exit 条件: Dify-Deck-Template の任意デッキで通る

### Phase 2: フォント本気対応 + Validator (2〜3 週)
- `fontkit` でサブセット化、`@font-face` 自動 fetch
- `@vellum/validator` の canvas 検出 / CSS 警告
- `::before` / `::after` のテキスト抽出
- パフォーマンス (raster 並列化, font cache)

### Phase 3: 自己チェック + UI (1〜2 週)
- pdf.js による self-check
- `@vellum/react` で `<DownloadPdfButton />` 提供
- `@vellum/astro` integration

### Phase 4: 公開 (タイミング次第)
- ドキュメント整備
- ベンチマーク・サンプル
- npm publish, GitHub OSS

---

## 10. リスク / 未解決事項

| リスク | 内容 | 緩和策 |
|---|---|---|
| **Range の座標精度** | 折り返しテキストの行ごとマッピング・段落途中の `<span>` の合成 | PoC 時に複数ブラウザで実測。`getClientRects` ベースで折れ線を吸収 |
| **`text-shadow` が消える** | 透明化で shadow も消える (`text-shadow: none !important` を入れているので) | オプションで shadow だけ残してラスタに焼く / ベクタ側で `drawText` を多重描画して影模倣 |
| **サブピクセル差** | ラスタとベクタテキストの位置が 1px ずれて見える | 文字 baseline の補正係数をフォント別に持つ。または半透明テキスト位置にラスタを軽くマスク |
| **CORS でフォント取れない** | Google Fonts 以外の `@font-face src` | v1 は Google Fonts Proxy のみサポート、それ以外はフォールバック警告 |
| **CJK のサブセット肥大** | 日本語 200 字でも数百KB | 共通フォントは資料間でキャッシュ、PDF 側は `subset: true` で確実に絞る |
| **`@font-face` が無いフォント** | system-ui 等 | Validator で警告。利用側でフォント指定を明示してもらう |
| **iframe / Shadow DOM** | walk が中まで入らない | **v1 では非対応**。v2 以降で `composedPath` / iframe 再帰探索を実装 |

---

## 11. 既存先行例との位置取り

| ライブラリ | アプローチ | 弱点 |
|---|---|---|
| `html2pdf.js` | DOM → canvas → PDF | 全部ラスタ、文字選択不可、ぼやける |
| `jsPDF.html()` | DOM → 限定 vector | CSS 対応が浅い、複雑レイアウト崩壊 |
| `puppeteer` (server) | Chrome の本物 print | サーバー必要、Cloudflare で動かない |
| `@cloudflare/puppeteer` | Browser Rendering API | 有料、設定重い |
| **本ツール** | **ラスタ (背景) + ベクタ (テキスト) ハイブリッド** | (新規) |

ニッチだが、**「ブラウザ内で完結する高品質 PDF」** を要求する用途 (スライド / 固定レイアウトドキュメント / レポート出力) で空白地帯。

---

## 12. 本リポジトリでの利用想定

```ts
// src/pages/[deck]/all.astro 内
import { domToPdf } from '@vellum/core'

btn.addEventListener('click', async () => {
  const blob = await domToPdf({
    pages: document.querySelectorAll('.slide-page'),
    source: { width: 1920, height: 1080 },
    output: { width: 960, height: 540, unit: 'pt' },
  })
  triggerDownload(blob, `${deck}.pdf`)
})
```

既存実装 (`html-to-image` + 雑な `pdf-lib`) を **15 行に置き換える**。コンポーネント側は一切触らない。

---

## 13. 確定済みの設計判断

| # | 論点 | 決定 |
|---|---|---|
| 1 | ラスタライザ | v1 は `html-to-image` 流用 (差し替え可能 IF を切る) |
| 2 | text-shadow / text-stroke の扱い | `preserveTextDecorations` オプションで残す/落とすを選択可、既定は落とす |
| 3 | フォント取得 | v1 は **Google Fonts Proxy のみ**。それ以外は標準フォント fallback + 警告 |
| 4 | Shadow DOM / iframe | **v1 非対応**、v2 以降検討 |

---

## 14. 次のアクション (このプランを承認したら)

2. Phase 0 PoC: `packages/core/poc/` で単一スライド検証
3. Dify-Deck-Template の `/<deck>/all` で実装差し替え (Phase 1 MVP 後)
4. フィードバック → Phase 2 以降を進める
