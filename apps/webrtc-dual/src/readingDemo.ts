function drawWrappedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number
) {
  const words = text.split(" ");
  let line = "";
  let yy = y;

  for (const w of words) {
    const candidate = line ? `${line} ${w}` : w;
    if (ctx.measureText(candidate).width > maxWidth && line) {
      ctx.fillText(line, x, yy);
      yy += lineHeight;
      line = w;
    } else {
      line = candidate;
    }
  }
  if (line) {
    ctx.fillText(line, x, yy);
    yy += lineHeight;
  }
  return yy;
}

export function drawReadingDemoPage(
  ctx: CanvasRenderingContext2D,
  patchW: number,
  patchH: number,
  supersample: number,
  _tSec: number
) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.setTransform(supersample, 0, 0, supersample, 0, 0);

  ctx.fillStyle = "#f6f2e8";
  ctx.fillRect(0, 0, patchW, patchH);

  ctx.fillStyle = "#1d1d1d";
  ctx.font = "bold 30px Georgia, serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText("Foveated Focus Demo", 28, 18);

  ctx.fillStyle = "#4a4a4a";
  ctx.font = "17px Georgia, serif";
  ctx.fillText("Foto + testo: la zona osservata deve restare nitida.", 28, 58);

  // Synthetic "photo" block with high-frequency details to make blur/focus obvious.
  const imgX = 34;
  const imgY = 94;
  const imgW = patchW - 68;
  const imgH = 210;
  const sky = ctx.createLinearGradient(imgX, imgY, imgX, imgY + imgH);
  sky.addColorStop(0, "#8fbadf");
  sky.addColorStop(0.55, "#c8dfef");
  sky.addColorStop(1, "#e8d8be");
  ctx.fillStyle = sky;
  ctx.fillRect(imgX, imgY, imgW, imgH);

  ctx.fillStyle = "#bda07a";
  ctx.fillRect(imgX, imgY + imgH * 0.72, imgW, imgH * 0.28);

  ctx.fillStyle = "#5d6f7f";
  ctx.beginPath();
  ctx.moveTo(imgX - 10, imgY + imgH * 0.72);
  ctx.lineTo(imgX + imgW * 0.22, imgY + imgH * 0.36);
  ctx.lineTo(imgX + imgW * 0.43, imgY + imgH * 0.72);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = "#6d7f8f";
  ctx.beginPath();
  ctx.moveTo(imgX + imgW * 0.24, imgY + imgH * 0.72);
  ctx.lineTo(imgX + imgW * 0.58, imgY + imgH * 0.27);
  ctx.lineTo(imgX + imgW * 0.82, imgY + imgH * 0.72);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = "rgba(28, 36, 46, 0.35)";
  ctx.lineWidth = 1;
  for (let i = 0; i < 20; i++) {
    const yy = imgY + imgH * 0.72 + i * 5;
    ctx.beginPath();
    ctx.moveTo(imgX, yy);
    ctx.lineTo(imgX + imgW, yy + Math.sin(i * 0.55) * 2.5);
    ctx.stroke();
  }

  ctx.strokeStyle = "rgba(0, 0, 0, 0.20)";
  ctx.lineWidth = 2;
  ctx.strokeRect(imgX, imgY, imgW, imgH);

  const paragraphs = [
    "Osserva i dettagli della foto: la porzione vicino allo sguardo resta nitida, la periferia appare piu morbida.",
    "Leggi questo testo e sposta lentamente lo sguardo: la lente deve seguire senza ritardi evidenti.",
    "Se vedi tremolio, ripeti la calibrazione in luce uniforme e mantieni testa e distanza piu costanti.",
    "Obiettivo demo finale: percezione chiara di focus dinamico su un unico contenuto fullscreen."
  ];

  ctx.fillStyle = "#292929";
  ctx.font = "22px Georgia, serif";
  let y = imgY + imgH + 20;
  for (const p of paragraphs) {
    y = drawWrappedText(ctx, p, 34, y, patchW - 68, 30) + 10;
  }

  const markerY = patchH - 74;
  ctx.fillStyle = "rgba(255, 188, 88, 0.24)";
  ctx.fillRect(28, markerY, patchW - 56, 38);
  ctx.strokeStyle = "rgba(200, 120, 30, 0.72)";
  ctx.lineWidth = 1.7;
  ctx.strokeRect(28, markerY, patchW - 56, 38);

  ctx.fillStyle = "#373737";
  ctx.font = "19px Georgia, serif";
  ctx.fillText("Riga guida: prova a fissare questa frase per 2 secondi.", 36, markerY + 8);

  ctx.strokeStyle = "rgba(0,0,0,0.24)";
  ctx.lineWidth = 2;
  ctx.strokeRect(16, 12, patchW - 32, patchH - 24);

  ctx.setTransform(1, 0, 0, 1, 0, 0);
}
