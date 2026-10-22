import fs from "node:fs/promises";
import path from "node:path";
import { Presentation, PresentationFile } from "@oai/artifact-tool";

const ROOT = process.cwd();
const TMP_DIR =
  process.env.PRESENTATION_TMP_DIR ||
  "/var/folders/gd/dbghghwd03198w0qrt8ntz0h0000gn/T/codex-presentations/019ea718-8670-76d1-ac8e-4389a76c61c0/osn-data-collection-presentation/tmp";
const OUT = path.join(ROOT, "outputs", "questionnaire_data_collection_sampling.pptx");
const PREVIEW_DIR = path.join(TMP_DIR, "final-preview");
const LAYOUT_DIR = path.join(TMP_DIR, "final-layout");
const LOGO_PATH = path.join(
  TMP_DIR,
  "template-inspect",
  "assets",
  "ppt",
  "media",
  "image2.png",
);
const ZJU_MARK_PATH = path.join(
  TMP_DIR,
  "template-inspect",
  "assets",
  "ppt",
  "media",
  "image5.png",
);
const GAME_TREE_PATH = path.join(ROOT, "outputs", "tree_screenshots", "game_question_graph_tree_only.png");
const ALL_OTHER_TREE_PATH = path.join(ROOT, "outputs", "tree_screenshots", "all_other_question_graph_tree_only.png");
const DEPTH4_EXAMPLE_PATH = path.join(ROOT, "outputs", "tree_screenshots", "depth4_branch_example_content.png");

const W = 1280;
const H = 720;
const BLUE = "#2F66E8";
const ZJU_BLUE = "#004098";
const DARK = "#20242A";
const MID = "#595959";
const BG = "#EEEEEE";
const WHITE = "#FFFFFF";
const GREEN = "#18A04D";
const PURPLE = "#7B3FE4";
const ORANGE = "#F5A400";
const LINE = "#A9A9A9";
const FONT = "Microsoft YaHei";

async function imageBytes(file) {
  const bytes = await fs.readFile(file);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function addLogo(slide, logo) {
  slide.images.add({
    blob: logo,
    contentType: "image/png",
    alt: "Zhejiang University logo",
    fit: "contain",
    position: { left: 952, top: 34, width: 285, height: 86 },
  });
}

function title(slide, text, size = 30) {
  const box = slide.shapes.add({
    geometry: "textbox",
    position: { left: 64, top: 66, width: 850, height: 55 },
    fill: "none",
    line: { style: "solid", fill: "none", width: 0 },
  });
  box.text = text;
  box.text.style = { fontFace: FONT, fontSize: size, bold: true, color: DARK };
  slide.shapes.add({
    geometry: "line",
    position: { left: 37, top: 123, width: 880, height: 0 },
    line: { style: "solid", fill: "#555555", width: 1.2 },
  });
  return box;
}

function textbox(slide, text, pos, style = {}) {
  const box = slide.shapes.add({
    geometry: "textbox",
    position: pos,
    fill: "none",
    line: { style: "solid", fill: "none", width: 0 },
  });
  box.text = text;
  box.text.style = {
    fontFace: FONT,
    fontSize: style.fontSize ?? 22,
    bold: style.bold ?? false,
    color: style.color ?? DARK,
    alignment: style.alignment,
  };
  return box;
}

function panel(slide, pos, opts = {}) {
  return slide.shapes.add({
    geometry: "rect",
    position: pos,
    fill: opts.fill ?? WHITE,
    line: { style: "solid", fill: opts.line ?? LINE, width: opts.width ?? 2 },
  });
}

function bulletBlock(slide, header, bullets, pos, accent = BLUE) {
  panel(slide, pos, { line: accent, width: 3 });
  textbox(slide, header, { left: pos.left + 24, top: pos.top + 26, width: pos.width - 48, height: 42 }, {
    fontSize: 24,
    bold: true,
    color: accent,
  });
  const body = bullets.map((item) => `• ${item}`).join("\n\n");
  textbox(slide, body, { left: pos.left + 28, top: pos.top + 88, width: pos.width - 56, height: pos.height - 110 }, {
    fontSize: 18,
    bold: true,
    color: DARK,
  });
}

function node(slide, label, x, y, w = 150, h = 46, fill = "#EAF1FF", stroke = BLUE, fontSize = 17) {
  const shape = slide.shapes.add({
    geometry: "roundRect",
    position: { left: x, top: y, width: w, height: h },
    fill,
    line: { style: "solid", fill: stroke, width: 1.6 },
    borderRadius: "rounded-lg",
  });
  shape.text = label;
  shape.text.style = { fontFace: FONT, fontSize, bold: true, color: DARK, alignment: "center" };
  return shape;
}

function arrow(slide, x1, y1, x2, y2, color = "#46566F") {
  slide.shapes.add({
    geometry: "line",
    position: { left: x1, top: y1, width: x2 - x1, height: y2 - y1 },
    line: { style: "solid", fill: color, width: 2.1, beginArrowType: "none", endArrowType: "triangle" },
  });
}

function circle(slide, label, x, y, fill, stroke = "#D7E3FF", size = 62) {
  const c = slide.shapes.add({
    geometry: "ellipse",
    position: { left: x, top: y, width: size, height: size },
    fill,
    line: { style: "solid", fill: stroke, width: 2 },
  });
  c.text = label;
  c.text.style = { fontFace: FONT, fontSize: 20, bold: true, color: WHITE, alignment: "center" };
  return c;
}

function metric(slide, num, label, x, y, color = BLUE) {
  panel(slide, { left: x, top: y, width: 180, height: 108 }, { line: "#D0D0D0", width: 1.5 });
  textbox(slide, String(num), { left: x, top: y + 18, width: 180, height: 44 }, {
    fontSize: 34,
    bold: true,
    color,
    alignment: "center",
  });
  textbox(slide, label, { left: x + 10, top: y + 65, width: 160, height: 30 }, {
    fontSize: 15,
    bold: true,
    color: MID,
    alignment: "center",
  });
}

function bar(slide, label, value, max, x, y, color) {
  const maxW = 320;
  textbox(slide, label, { left: x, top: y - 4, width: 165, height: 24 }, { fontSize: 16, bold: true, color: DARK });
  slide.shapes.add({
    geometry: "rect",
    position: { left: x + 175, top: y, width: maxW, height: 25 },
    fill: "#E6E6E6",
    line: { style: "solid", fill: "none", width: 0 },
  });
  slide.shapes.add({
    geometry: "rect",
    position: { left: x + 175, top: y, width: (value / max) * maxW, height: 25 },
    fill: color,
    line: { style: "solid", fill: "none", width: 0 },
  });
  textbox(slide, String(value), { left: x + 510, top: y - 4, width: 70, height: 25 }, {
    fontSize: 16,
    bold: true,
    color: DARK,
  });
}

async function main() {
  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.mkdir(PREVIEW_DIR, { recursive: true });
  await fs.mkdir(LAYOUT_DIR, { recursive: true });
  const logo = await imageBytes(LOGO_PATH);
  const mark = await imageBytes(ZJU_MARK_PATH);
  const gameTree = await imageBytes(GAME_TREE_PATH);
  const allOtherTree = await imageBytes(ALL_OTHER_TREE_PATH);
  const depth4Example = await imageBytes(DEPTH4_EXAMPLE_PATH);

  const p = Presentation.create({ slideSize: { width: W, height: H } });

  {
    const slide = p.slides.add();
    slide.background.fill = BG;
    addLogo(slide, logo);
    slide.shapes.add({
      geometry: "parallelogram",
      position: { left: 150, top: 278, width: 990, height: 230 },
      fill: "#315C9C",
      line: { style: "solid", fill: "none", width: 0 },
    });
    slide.shapes.add({
      geometry: "parallelogram",
      position: { left: 950, top: 404, width: 370, height: 150 },
      fill: "#27477A",
      line: { style: "solid", fill: "none", width: 0 },
    });
    slide.images.add({
      blob: mark,
      contentType: "image/png",
      alt: "ZJU mark",
      fit: "contain",
      position: { left: 30, top: 224, width: 235, height: 220 },
    });
    textbox(slide, "Questionnaire Data Collection", { left: 340, top: 318, width: 760, height: 48 }, {
      fontSize: 34,
      bold: true,
      color: WHITE,
    });
    textbox(slide, "Question Structure Recovery and Sample Collection", { left: 340, top: 370, width: 670, height: 40 }, {
      fontSize: 25,
      bold: true,
      color: WHITE,
    });
    textbox(slide, "IARC Rating Questionnaire", { left: 340, top: 426, width: 450, height: 28 }, {
      fontSize: 18,
      bold: true,
      color: "#111111",
    });
  }

  {
    const slide = p.slides.add();
    slide.background.fill = BG;
    addLogo(slide, logo);
    title(slide, "Part 1: Recovering the Questionnaire Graph with DFS");
    bulletBlock(slide, "Core idea", [
      "Start traversal from multiple root questions",
      "Click each option and record newly revealed child questions",
      "Apply the same recursive process to each child question",
      "Backtrack after each branch and continue exploring other options",
      "Recover a question-option-child graph instead of a flat question list",
    ], { left: 52, top: 170, width: 520, height: 438 });
    panel(slide, { left: 620, top: 178, width: 610, height: 370 });
    node(slide, "Root Question", 670, 230, 165, 48);
    node(slide, "Option: Yes", 680, 332, 150, 46, "#E8FFF1", GREEN);
    node(slide, "Option: No", 910, 332, 150, 46, "#F2F2F2", "#888888");
    node(slide, "Child Question", 672, 440, 170, 48, "#F0E9FF", PURPLE);
    node(slide, "Terminate", 912, 440, 150, 48, "#FFF4D8", ORANGE);
    arrow(slide, 752, 278, 752, 332);
    arrow(slide, 835, 255, 985, 332);
    arrow(slide, 755, 378, 755, 440, GREEN);
    arrow(slide, 985, 378, 985, 440, "#888888");
    textbox(slide, "DFS + Backtracking", { left: 732, top: 563, width: 390, height: 36 }, {
      fontSize: 24,
      bold: true,
      color: ZJU_BLUE,
      alignment: "center",
    });
  }

  {
    const slide = p.slides.add();
    slide.background.fill = BG;
    addLogo(slide, logo);
    title(slide, "Recovered Structure: Complete Game Tree");
    textbox(slide, "The full tree shows every recovered question node and option-triggered edge; node labels are shortened to fit one slide.", {
      left: 68,
      top: 145,
      width: 1040,
      height: 34,
    }, { fontSize: 21, bold: true, color: MID });
    panel(slide, { left: 52, top: 184, width: 1176, height: 505 }, { line: BLUE, width: 3 });
    slide.images.add({
      blob: gameTree,
      contentType: "image/png",
      alt: "Game questionnaire complete tree",
      fit: "contain",
      position: { left: 67, top: 197, width: 1146, height: 480 },
    });
  }

  {
    const slide = p.slides.add();
    slide.background.fill = BG;
    addLogo(slide, logo);
    title(slide, "Recovered Structure: Complete All Other Tree");
    textbox(slide, "The full tree shows every recovered question node and option-triggered edge; node labels are shortened to fit one slide.", {
      left: 68,
      top: 145,
      width: 1040,
      height: 34,
    }, { fontSize: 21, bold: true, color: MID });
    panel(slide, { left: 52, top: 184, width: 1176, height: 505 }, { line: PURPLE, width: 3 });
    slide.images.add({
      blob: allOtherTree,
      contentType: "image/png",
      alt: "All Other App Types complete tree",
      fit: "contain",
      position: { left: 67, top: 197, width: 1146, height: 480 },
    });
  }

  {
    const slide = p.slides.add();
    slide.background.fill = BG;
    addLogo(slide, logo);
    title(slide, "Expansion Example: Depth-4 Question and Children");
    textbox(slide, "A complete All Other gambling subtree: all recovered option-triggered questions are shown through depth 4.", {
      left: 68,
      top: 145,
      width: 1070,
      height: 34,
    }, { fontSize: 21, bold: true, color: MID });
    slide.images.add({
      blob: depth4Example,
      contentType: "image/png",
      alt: "Depth-4 branch example screenshot",
      fit: "contain",
      position: { left: 48, top: 198, width: 1184, height: 450 },
    });
    textbox(slide, "The screenshot is generated from HTML and follows the same compact tree style as the full-structure slides.", {
      left: 145,
      top: 655,
      width: 990,
      height: 30,
    }, { fontSize: 18, bold: true, color: DARK, alignment: "center" });
  }

  {
    const slide = p.slides.add();
    slide.background.fill = BG;
    addLogo(slide, logo);
    title(slide, "Part 2: Questionnaire Sample Collection Strategy");
    textbox(slide, "The Social tree has only 12 questions and 24 options, with limited rating signal, so it is excluded from the main sampling target.", {
      left: 70,
      top: 145,
      width: 1090,
      height: 32,
    }, { fontSize: 20, bold: true, color: MID });
    const xs = [92, 372, 652, 932];
    const labels = [
      ["Baseline", "Choose the lowest-risk answers to establish the minimum-rating path"],
      ["Structural coverage", "Prioritize options that reveal child questions and increase coverage"],
      ["Risk paths", "Combine risk type and severity choices to cover different rating outcomes"],
      ["Gap filling", "Identify low-frequency options and add targeted supplemental samples"],
    ];
    labels.forEach(([h, b], i) => {
      const x = xs[i];
      circle(slide, String(i + 1), x + 84, 230, [BLUE, GREEN, PURPLE, ORANGE][i], "#D6E3FF", 58);
      panel(slide, { left: x, top: 315, width: 240, height: 210 }, { line: "#CFCFCF", width: 1.5 });
      textbox(slide, h, { left: x + 18, top: 342, width: 204, height: 32 }, {
        fontSize: 24,
        bold: true,
        color: [BLUE, GREEN, PURPLE, ORANGE][i],
        alignment: "center",
      });
      textbox(slide, b, { left: x + 24, top: 395, width: 192, height: 90 }, {
        fontSize: 17,
        bold: true,
        color: DARK,
        alignment: "center",
      });
      if (i < 3) arrow(slide, x + 236, 258, xs[i + 1] + 84, 258);
    });
    textbox(slide, "Goal: build a coverage-oriented dataset for learning rating logic, rather than simulating a natural answer distribution.", {
      left: 160,
      top: 585,
      width: 960,
      height: 34,
    }, { fontSize: 22, bold: true, color: DARK, alignment: "center" });
  }

  {
    const slide = p.slides.add();
    slide.background.fill = BG;
    addLogo(slide, logo);
    title(slide, "Part 3: Final Data Distribution");
    panel(slide, { left: 60, top: 165, width: 595, height: 380 });
    textbox(slide, "ESRB Label Distribution", { left: 95, top: 195, width: 360, height: 34 }, {
      fontSize: 25,
      bold: true,
      color: DARK,
    });
    const dist = [
      ["Mature 17+", 365, BLUE],
      ["Teen", 339, PURPLE],
      ["Adults only 18+", 241, GREEN],
      ["Everyone", 182, ORANGE],
      ["Everyone 10+", 138, "#5DADE2"],
    ];
    dist.forEach(([label, value, color], i) => bar(slide, label, value, 365, 95, 258 + i * 52, color));
    panel(slide, { left: 700, top: 185, width: 500, height: 150 }, { line: "none", width: 0 });
    textbox(slide, "Main dataset", { left: 735, top: 212, width: 260, height: 32 }, {
      fontSize: 25,
      bold: true,
      color: DARK,
    });
    textbox(slide, "Game + All Other Types", { left: 735, top: 260, width: 380, height: 34 }, {
      fontSize: 22,
      bold: true,
      color: BLUE,
    });
    panel(slide, { left: 700, top: 392, width: 500, height: 145 }, { line: "none", width: 0 });
    textbox(slide, "Takeaway", { left: 735, top: 420, width: 160, height: 30 }, {
      fontSize: 24,
      bold: true,
      color: DARK,
    });
    textbox(slide, "The samples cover the major rating labels from Everyone to Adults Only 18+, supporting downstream multi-class modeling.", {
      left: 735,
      top: 468,
      width: 410,
      height: 50,
    }, { fontSize: 20, bold: true, color: MID });
    textbox(slide, "The Social tree has limited signal and is excluded from the main model training set.", {
      left: 250,
      top: 585,
      width: 780,
      height: 32,
    }, { fontSize: 20, bold: true, color: DARK, alignment: "center" });
  }

  for (const [i, slide] of p.slides.items.entries()) {
    const stem = `slide-${String(i + 1).padStart(2, "0")}`;
    const png = await p.export({ slide, format: "png", scale: 1 });
    await fs.writeFile(path.join(PREVIEW_DIR, `${stem}.png`), new Uint8Array(await png.arrayBuffer()));
    const layout = await slide.export({ format: "layout" });
    await fs.writeFile(path.join(LAYOUT_DIR, `${stem}.layout.json`), await layout.text());
  }
  const montage = await p.export({ format: "webp", montage: true, scale: 1 });
  await fs.writeFile(path.join(PREVIEW_DIR, "montage.webp"), new Uint8Array(await montage.arrayBuffer()));

  const pptx = await PresentationFile.exportPptx(p);
  await pptx.save(OUT);
  console.log(OUT);
  console.log(PREVIEW_DIR);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
