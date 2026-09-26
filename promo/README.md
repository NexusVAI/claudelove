# 字形构造宣传片 · Type Construction Promo

一条 10.4 秒、1080p/4K、60fps 的原创动态字标片：灰底瑞士极简风，字形从度量线 → 轮廓描边（锚点 + 控制柄）→ 扫描填充 → 字距收紧 → 打字收尾，每个动作都有逐帧对齐的音效。

成片在 `dist/`：

| 文件 | 规格 |
| --- | --- |
| `dist/promo_1080p60.mp4` | 1920×1080 · 60fps · H.264 + AAC 256k |
| `dist/promo_2160p60.mp4` | 3840×2160 · 60fps · H.264 + AAC 256k |

> 风格参考的是一段品牌规范动效，但这里的画面、字形、分镜、文案和声音都是原创的：没有使用参考片里的商标/字标、产品名或原配乐。

## 改成你自己的字

只改 `config.json` 然后重新构建：

```jsonc
{
  "brand": "NexusVAI",                       // 主字标（任意拉丁字符）
  "tagline": "Where intelligence connects.", // 结尾打字的那句话
  "hud": { "title": [...], "credit": [...] }, // 四角小字
  "sections": ["01  Grid", ...],             // 左下角章节名（会乱码切换）
  "outro": "© 2026 NexusVAI",
  "tracking": -26,                           // 第 4 段收紧的字距（字体单位）
  "palette": { "bg": "#C1C1BF", "ink": "#0B0B0C" }
}
```

锚点、控制柄、字宽数字都是从字体文件里实时读出来的，换字不需要改任何代码。

## 构建

需要 Node 18+、ffmpeg、Chromium（Playwright 的 Chromium 即可，或用 `CHROMIUM_PATH` 指定任意 Chrome）。

```bash
cd promo
npm install
npm run build      # = frames（逐帧截图）→ audio（合成音效）→ encode（响度标准化 + 编码）
npm run preview    # 打开 http://127.0.0.1:5173 实时预览，空格播放/暂停，拖动进度条
```

单独出几张静帧检查：`node scripts/render.mjs --stills=1.5,4.2 --scale=1`

## 技术栈

- **画面**：Canvas 2D，所有元素都是时间 t 的纯函数（`src/main.js` 的 `renderAt(t)`），所以预览和离线渲染逐帧一致。
- **字形数据**：[opentype.js](https://github.com/opentypejs/opentype.js) 解析 Geist 字体，TrueType 二次曲线解码成折线用于描边动画；平滑点画圆、角点画方块、离线控制点画小实心点（字体编辑器的惯例）。
- **渲染**：Playwright 驱动无头 Chromium，2× 超采样逐帧截图，再用 ffmpeg 缩放编码（x264 `-tune animation`）。
- **声音**：`scripts/audio.mjs` 用振荡器 + 噪声 + 滤波器纯合成，没有任何采样文件；音效时间点由画面同一套时间线导出（`out/events.json`），按元素在屏幕上的位置做立体声声像，再过一个 Freeverb 式混响；最后两遍 EBU R128 响度标准化到 −15 LUFS / −1.2 dBTP。

## 这类音效叫什么

| 本片里的声音 | 常见叫法（搜素材用的关键词） |
| --- | --- |
| 锚点弹出、刻度线的密集“哒哒”声 | UI click / tick、interface click、mechanical click、data chatter |
| 扫描时的高频小音符 | data blip、computer bleep、sci-fi UI beep |
| 填充时的低沉闷击 | thock / thump、UI impact、low hit |
| 完成时的“叮” | sine ping、notification ping、bell blip |
| 打字 | keyboard typing、key press / key release |
| 转场的“呼” | whoosh、swish、air sweep |
| 打字时垫底的和弦 | synth pad、ambient pad |

可商用的开源/免版税素材库：

- [Kenney · UI Audio](https://kenney.nl/assets/ui-audio)、[Kenney · Interface Sounds](https://kenney.nl/assets/interface-sounds)：CC0，按钮/开关/点击音。
- [Sonniss GDC Game Audio Bundle](https://gdc.sonniss.com/)：每年免费发布的大合集，免版税、无需署名（[许可证](https://sonniss.com/gdc-bundle-license/)）。
- [Freesound](https://freesound.org/)：搜索时把许可证筛选为 Creative Commons 0。

## 许可

- 字体 Geist：SIL Open Font License 1.1（`fonts/OFL.txt`）
- opentype.js：MIT（`src/vendor/opentype.LICENSE`）
