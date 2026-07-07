import {
  Download,
  ImageIcon,
  Loader2,
  RotateCcw,
  SlidersHorizontal,
  Sparkles,
  SplitSquareHorizontal,
  Trash2,
  UploadCloud,
} from 'lucide-react';
import {
  ChangeEvent,
  DragEvent,
  PointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

type FilterSettings = {
  glow: number;
  grain: number;
  contrast: number;
  vignette: number;
  dotFade: number;
  formDots: number;
  toneMap: number;
};

type SourceImage = {
  image: HTMLImageElement;
  fileName: string;
};

type ViewMode = 'processed' | 'split';

const defaultSettings: FilterSettings = {
  glow: 86,
  grain: 20,
  contrast: 40,
  vignette: 44,
  dotFade: 10,
  formDots: 48,
  toneMap: 28,
};

const MAX_CANVAS_SIDE = 1800;
const GREEN_LOW = [11, 18, 15] as const;
const GREEN_HIGH = [201, 224, 193] as const;

function clamp(value: number, min = 0, max = 255) {
  return Math.min(max, Math.max(min, value));
}

function seededNoise(x: number, y: number, seed: number) {
  const value = Math.sin(x * 12.9898 + y * 78.233 + seed * 37.719) * 43758.5453;
  return value - Math.floor(value);
}

function smoothstep(edge0: number, edge1: number, value: number) {
  const amount = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return amount * amount * (3 - 2 * amount);
}

function fitDimensions(width: number, height: number) {
  const scale = Math.min(1, MAX_CANVAS_SIDE / Math.max(width, height));

  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function getPercentile(histogram: number[], total: number, percentile: number) {
  const target = total * percentile;
  let seen = 0;

  for (let index = 0; index < histogram.length; index += 1) {
    seen += histogram[index];

    if (seen >= target) {
      return index / (histogram.length - 1);
    }
  }

  return 1;
}

function getLuminance(luminance: Float32Array, width: number, height: number, x: number, y: number) {
  const sampleX = Math.min(width - 1, Math.max(0, x));
  const sampleY = Math.min(height - 1, Math.max(0, y));
  return luminance[sampleY * width + sampleX];
}

function makeSafeFileName(name: string) {
  return name.replace(/\.[^.]+$/, '').replace(/[^a-z0-9-_]+/gi, '-').toLowerCase();
}

function drawFormAwareStipple(
  context: CanvasRenderingContext2D,
  luminance: Float32Array,
  tone: Float32Array,
  width: number,
  height: number,
  settings: FilterSettings,
) {
  const formStrength = settings.formDots / 100;

  if (formStrength <= 0) {
    return;
  }

  const grain = settings.grain / 100;
  const spacing = Math.max(2.05, 4.05 - grain * 1.25 - formStrength * 0.55);
  const seed = width * 0.07 + height * 0.11 + settings.contrast * 0.13;
  const density = 0.42 + grain * 0.24 + formStrength * 0.82;
  const dotScale = 0.58 + formStrength * 0.46;

  context.save();
  context.globalCompositeOperation = 'source-over';
  context.fillStyle = 'rgb(156, 178, 151)';

  for (let y = 2; y < height - 2; y += spacing) {
    const row = Math.floor(y / spacing);

    for (let x = 2; x < width - 2; x += spacing) {
      const column = Math.floor(x / spacing);
      const jitterX = (seededNoise(column, row, seed) - 0.5) * spacing * 0.96;
      const jitterY = (seededNoise(column, row, seed + 9.7) - 0.5) * spacing * 0.96;
      const sampleX = Math.min(width - 2, Math.max(1, Math.round(x + jitterX)));
      const sampleY = Math.min(height - 2, Math.max(1, Math.round(y + jitterY)));
      const index = sampleY * width + sampleX;
      const surfaceTone = tone[index];

      const gx =
        -getLuminance(luminance, width, height, sampleX - 1, sampleY - 1) +
        getLuminance(luminance, width, height, sampleX + 1, sampleY - 1) -
        2 * getLuminance(luminance, width, height, sampleX - 1, sampleY) +
        2 * getLuminance(luminance, width, height, sampleX + 1, sampleY) -
        getLuminance(luminance, width, height, sampleX - 1, sampleY + 1) +
        getLuminance(luminance, width, height, sampleX + 1, sampleY + 1);
      const gy =
        -getLuminance(luminance, width, height, sampleX - 1, sampleY - 1) -
        2 * getLuminance(luminance, width, height, sampleX, sampleY - 1) -
        getLuminance(luminance, width, height, sampleX + 1, sampleY - 1) +
        getLuminance(luminance, width, height, sampleX - 1, sampleY + 1) +
        2 * getLuminance(luminance, width, height, sampleX, sampleY + 1) +
        getLuminance(luminance, width, height, sampleX + 1, sampleY + 1);
      const edge = smoothstep(0.025, 0.28, Math.sqrt(gx * gx + gy * gy));
      const leftTone = tone[sampleY * width + sampleX - 1] ?? surfaceTone;
      const rightTone = tone[sampleY * width + sampleX + 1] ?? surfaceTone;
      const topTone = tone[(sampleY - 1) * width + sampleX] ?? surfaceTone;
      const bottomTone = tone[(sampleY + 1) * width + sampleX] ?? surfaceTone;
      const localToneAverage = (surfaceTone * 4 + leftTone + rightTone + topTone + bottomTone) / 8;
      const localDetail = smoothstep(0.006, 0.12, Math.abs(surfaceTone - localToneAverage) + edge * 0.14);
      const darkSurface =
        smoothstep(0.025, 0.22, surfaceTone) * (1 - smoothstep(0.5, 0.72, surfaceTone));
      const highlightBlock = 1 - smoothstep(0.5, 0.66, surfaceTone);
      const structuredShadow = clamp(0.22 + edge * 0.72 + localDetail * 0.64, 0, 1);
      const surfacePresence = clamp(
        darkSurface * highlightBlock * structuredShadow,
        0,
        1,
      );
      const chance = surfacePresence * density;

      if (seededNoise(column, row, seed + 21.3) > chance) {
        continue;
      }

      const radius = Math.max(
        0.24,
        (0.24 + darkSurface * 0.34 + localDetail * 0.1 + edge * 0.08) * dotScale,
      );
      const alpha = clamp(
        0.18 + darkSurface * 0.28 + localDetail * 0.08 + formStrength * 0.18,
        0.12,
        0.62,
      );

      context.globalAlpha = alpha;
      context.beginPath();
      context.arc(sampleX, sampleY, radius, 0, Math.PI * 2);
      context.fill();
    }
  }

  context.restore();
}

function applyFilter(
  sourceCanvas: HTMLCanvasElement,
  outputCanvas: HTMLCanvasElement,
  settings: FilterSettings,
) {
  const width = sourceCanvas.width;
  const height = sourceCanvas.height;
  outputCanvas.width = width;
  outputCanvas.height = height;

  const sourceContext = sourceCanvas.getContext('2d', { willReadFrequently: true });
  const outputContext = outputCanvas.getContext('2d');

  if (!sourceContext || !outputContext) {
    return;
  }

  const imageData = sourceContext.getImageData(0, 0, width, height);
  const { data } = imageData;
  const luminance = new Float32Array(width * height);
  const tone = new Float32Array(width * height);
  const histogram = Array.from({ length: 256 }, () => 0);
  const contrast = 0.82 + settings.contrast / 58;
  const grainStrength = settings.grain / 100;
  const glow = settings.glow / 100;
  const vignette = settings.vignette / 100;
  const dotFade = settings.dotFade / 100;
  const centerX = width / 2;
  const centerY = height / 2;
  const maxDistance = Math.sqrt(centerX * centerX + centerY * centerY);
  const seed = width * 0.13 + height * 0.17 + settings.grain * 0.03;
  let luminanceTotal = 0;

  for (let index = 0; index < data.length; index += 4) {
    const red = data[index];
    const green = data[index + 1];
    const blue = data[index + 2];
    const luminanceValue = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
    luminance[index / 4] = luminanceValue;
    luminanceTotal += luminanceValue;
    histogram[Math.min(255, Math.max(0, Math.round(luminanceValue * 255)))] += 1;
  }

  const pixelCount = width * height;
  const imageMean = luminanceTotal / pixelCount;
  const brightImage = smoothstep(0.54, 0.78, imageMean);
  const toneMap = settings.toneMap / 100;
  const rawBlackPoint = getPercentile(
    histogram,
    pixelCount,
    0.02 + toneMap * (0.06 + brightImage * 0.05),
  );
  const rawWhitePoint = getPercentile(histogram, pixelCount, 0.985 - toneMap * 0.02);
  const rawRange = rawWhitePoint - rawBlackPoint;
  const shadowPadding = rawRange < 0.18 ? 0.09 - toneMap * 0.04 : 0.035 - toneMap * 0.015;
  const highlightPadding = rawRange < 0.18 ? 0.03 + toneMap * 0.01 : 0.006 + toneMap * 0.008;
  const blackPoint = clamp(rawBlackPoint - shadowPadding, 0, 1);
  const whitePoint = clamp(rawWhitePoint + highlightPadding, 0, 1);
  const tonalRange = Math.max(0.08, whitePoint - blackPoint);
  const blackCrush = toneMap * (0.04 + brightImage * 0.16);
  const clarity = 0.06 + settings.contrast / 520 + toneMap * (0.18 + brightImage * 0.1);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const luminanceValue = luminance[y * width + x];
      const normalized = clamp((luminanceValue - blackPoint) / tonalRange, 0, 1);
      const localAverage =
        (normalized * 4 +
          clamp((getLuminance(luminance, width, height, x - 1, y) - blackPoint) / tonalRange, 0, 1) +
          clamp((getLuminance(luminance, width, height, x + 1, y) - blackPoint) / tonalRange, 0, 1) +
          clamp((getLuminance(luminance, width, height, x, y - 1) - blackPoint) / tonalRange, 0, 1) +
          clamp((getLuminance(luminance, width, height, x, y + 1) - blackPoint) / tonalRange, 0, 1)) /
        8;
      const shapedLuminance = clamp(normalized + (normalized - localAverage) * clarity, 0, 1);
      const noise = (seededNoise(x, y, seed) - 0.5) * grainStrength;
      const cellSize = 5;
      const cellX = (x % cellSize) - cellSize / 2;
      const cellY = (y % cellSize) - cellSize / 2;
      const dot = Math.sqrt(cellX * cellX + cellY * cellY) / (cellSize / 2);
      const dotTexture = dotFade * Math.max(0, dot - 0.45) * 0.35;
      const distance = Math.sqrt((x - centerX) ** 2 + (y - centerY) ** 2) / maxDistance;
      const edgeShade = Math.pow(distance, 1.85) * vignette * 0.62;
      const brightened = Math.pow(shapedLuminance, 0.92 - glow * 0.16);
      const crushed = clamp((brightened - blackCrush) / (1 - blackCrush * 0.66), 0, 1);
      const depthCurve = Math.pow(crushed, 1 + toneMap * (0.16 + brightImage * 0.2));
      const toned = clamp((depthCurve - 0.5) * contrast + 0.5 + noise - edgeShade - dotTexture, 0, 1);
      const lifted = Math.pow(toned, 1 + toneMap * (0.16 + brightImage * 0.2));
      tone[y * width + x] = lifted;

      data[index] = clamp(GREEN_LOW[0] + (GREEN_HIGH[0] - GREEN_LOW[0]) * lifted);
      data[index + 1] = clamp(GREEN_LOW[1] + (GREEN_HIGH[1] - GREEN_LOW[1]) * lifted);
      data[index + 2] = clamp(GREEN_LOW[2] + (GREEN_HIGH[2] - GREEN_LOW[2]) * lifted);
      data[index + 3] = 255;
    }
  }

  outputContext.putImageData(imageData, 0, 0);
  drawFormAwareStipple(outputContext, luminance, tone, width, height, settings);
}

function App() {
  const [settings, setSettings] = useState(defaultSettings);
  const [source, setSource] = useState<SourceImage | null>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('processed');
  const [splitPosition, setSplitPosition] = useState(52);
  const [error, setError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const sourceCanvasRef = useRef<HTMLCanvasElement>(null);
  const outputCanvasRef = useRef<HTMLCanvasElement>(null);
  const previewFrameRef = useRef<HTMLDivElement>(null);
  const imageStageRef = useRef<HTMLDivElement>(null);
  const [stageSize, setStageSize] = useState<{ width: number; height: number } | null>(null);

  const ready = Boolean(source);

  const loadFile = useCallback((file: File) => {
    if (!file.type.startsWith('image/')) {
      setError('Pick an image file');
      return;
    }

    setBusy(true);
    setError('');

    const objectUrl = URL.createObjectURL(file);
    const image = new Image();

    image.onload = () => {
      setSource({ image, fileName: file.name });
      setBusy(false);
      URL.revokeObjectURL(objectUrl);
    };

    image.onerror = () => {
      setBusy(false);
      setError('That image did not load');
      URL.revokeObjectURL(objectUrl);
    };

    image.src = objectUrl;
  }, []);

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];

    if (file) {
      loadFile(file);
    }

    event.target.value = '';
  };

  const handleDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setDragging(false);

    const file = event.dataTransfer.files?.[0];

    if (file) {
      loadFile(file);
    }
  };

  const drawSource = useCallback(() => {
    const sourceCanvas = sourceCanvasRef.current;

    if (!source || !sourceCanvas) {
      return;
    }

    const context = sourceCanvas.getContext('2d');
    const dimensions = fitDimensions(source.image.naturalWidth, source.image.naturalHeight);
    sourceCanvas.width = dimensions.width;
    sourceCanvas.height = dimensions.height;

    if (!context) {
      return;
    }

    context.clearRect(0, 0, dimensions.width, dimensions.height);
    context.drawImage(source.image, 0, 0, dimensions.width, dimensions.height);
  }, [source]);

  useEffect(() => {
    if (!source) {
      setStageSize(null);
      return;
    }

    setBusy(true);

    const frame = window.requestAnimationFrame(() => {
      drawSource();

      if (sourceCanvasRef.current && outputCanvasRef.current) {
        applyFilter(sourceCanvasRef.current, outputCanvasRef.current, settings);
      }

      setBusy(false);
    });

    return () => window.cancelAnimationFrame(frame);
  }, [drawSource, settings, source]);

  useEffect(() => {
    const frame = previewFrameRef.current;

    if (!source || !frame) {
      return;
    }

    const updateStageSize = () => {
      const frameRect = frame.getBoundingClientRect();
      const maxWidth = Math.max(1, frameRect.width - 34);
      const maxHeight = Math.max(1, frameRect.height - 34);
      const fitted = fitDimensions(source.image.naturalWidth, source.image.naturalHeight);
      const aspectRatio = fitted.width / fitted.height;
      const size =
        maxWidth / maxHeight > aspectRatio
          ? { width: Math.round(maxHeight * aspectRatio), height: Math.round(maxHeight) }
          : { width: Math.round(maxWidth), height: Math.round(maxWidth / aspectRatio) };

      setStageSize(size);
    };

    updateStageSize();

    const resizeObserver = new ResizeObserver(updateStageSize);
    resizeObserver.observe(frame);
    window.addEventListener('resize', updateStageSize);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', updateStageSize);
    };
  }, [source]);

  const downloadImage = () => {
    const canvas = outputCanvasRef.current;

    if (!canvas || !source) {
      return;
    }

    const link = document.createElement('a');
    link.download = `${makeSafeFileName(source.fileName)}-chroma-grain.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
  };

  const updateSetting = (key: keyof FilterSettings, value: number) => {
    setSettings((current) => ({
      ...current,
      [key]: value,
    }));
  };

  const clearImage = () => {
    setSource(null);
    setError('');
    const sourceCanvas = sourceCanvasRef.current;
    const outputCanvas = outputCanvasRef.current;
    sourceCanvas?.getContext('2d')?.clearRect(0, 0, sourceCanvas.width, sourceCanvas.height);
    outputCanvas?.getContext('2d')?.clearRect(0, 0, outputCanvas.width, outputCanvas.height);
  };

  const handleSplitDrag = (event: PointerEvent<HTMLDivElement>) => {
    const stage = imageStageRef.current;

    if (!stage) {
      return;
    }

    const rect = stage.getBoundingClientRect();
    const next = ((event.clientX - rect.left) / rect.width) * 100;
    setSplitPosition(clamp(next, 6, 94));
  };

  const sliderItems = useMemo(
    () => [
      { key: 'glow' as const, label: 'Glow', min: 0, max: 100 },
      { key: 'grain' as const, label: 'Grain', min: 0, max: 100 },
      { key: 'contrast' as const, label: 'Contrast', min: 0, max: 100 },
      { key: 'vignette' as const, label: 'Vignette', min: 0, max: 100 },
      { key: 'dotFade' as const, label: 'Dot fade', min: 0, max: 100 },
      { key: 'formDots' as const, label: 'Form dots', min: 0, max: 100 },
      { key: 'toneMap' as const, label: 'Tone map', min: 0, max: 100 },
    ],
    [],
  );

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">
            <Sparkles size={18} />
          </div>
          <div>
            <h1>Chroma Grain</h1>
            <p>Monochrome green image lab</p>
          </div>
        </div>

        <div className="top-actions">
          <button
            className="icon-button"
            type="button"
            title="Reset filter"
            onClick={() => setSettings(defaultSettings)}
          >
            <RotateCcw size={18} />
          </button>
          <button
            className="primary-button"
            type="button"
            disabled={!ready}
            onClick={downloadImage}
          >
            <Download size={18} />
            <span>Export</span>
          </button>
        </div>
      </header>

      <section className="workspace">
        <aside className="tool-panel" aria-label="Image tools">
          <label
            className={`drop-zone ${dragging ? 'is-dragging' : ''}`}
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleFileChange}
            />
            <span className="drop-icon" aria-hidden="true">
              <UploadCloud size={24} />
            </span>
            <strong>Drop image</strong>
            <small>{source?.fileName ?? 'PNG, JPG, WEBP'}</small>
          </label>

          {error && <p className="status-message">{error}</p>}

          <div className="panel-section">
            <div className="panel-heading">
              <SlidersHorizontal size={17} />
              <h2>Filter</h2>
            </div>

            <div className="sliders">
              {sliderItems.map((item) => (
                <label className="slider-row" key={item.key}>
                  <span>
                    <b>{item.label}</b>
                    <output>{settings[item.key]}</output>
                  </span>
                  <input
                    type="range"
                    min={item.min}
                    max={item.max}
                    value={settings[item.key]}
                    onChange={(event) => updateSetting(item.key, Number(event.target.value))}
                  />
                </label>
              ))}
            </div>
          </div>

          <div className="panel-section compact-actions">
            <button
              className={viewMode === 'processed' ? 'mode-button is-active' : 'mode-button'}
              type="button"
              title="Processed view"
              onClick={() => setViewMode('processed')}
            >
              <ImageIcon size={17} />
              <span>Final</span>
            </button>
            <button
              className={viewMode === 'split' ? 'mode-button is-active' : 'mode-button'}
              type="button"
              title="Split view"
              onClick={() => setViewMode('split')}
            >
              <SplitSquareHorizontal size={17} />
              <span>Split</span>
            </button>
            <button
              className="mode-button danger"
              type="button"
              title="Clear image"
              disabled={!ready}
              onClick={clearImage}
            >
              <Trash2 size={17} />
              <span>Clear</span>
            </button>
          </div>
        </aside>

        <section className="preview-panel" aria-label="Image preview">
          <div
            ref={previewFrameRef}
            className={`preview-frame ${ready ? 'has-image' : ''}`}
          >
            {!ready && (
              <button
                className="empty-state"
                type="button"
                onClick={() => fileInputRef.current?.click()}
              >
                <UploadCloud size={34} />
                <span>Choose image</span>
              </button>
            )}

            {ready && (
              <div
                ref={imageStageRef}
                className="image-stage"
                style={
                  stageSize
                    ? { width: `${stageSize.width}px`, height: `${stageSize.height}px` }
                    : undefined
                }
                onPointerDown={(event) => {
                  if (viewMode === 'split') {
                    event.currentTarget.setPointerCapture(event.pointerId);
                    handleSplitDrag(event);
                  }
                }}
                onPointerMove={(event) => {
                  if (
                    viewMode === 'split' &&
                    event.currentTarget.hasPointerCapture(event.pointerId)
                  ) {
                    handleSplitDrag(event);
                  }
                }}
              >
                <canvas
                  ref={outputCanvasRef}
                  className="preview-canvas"
                  aria-label="Filtered image"
                />
                <canvas
                  ref={sourceCanvasRef}
                  className="preview-canvas source-canvas"
                  aria-label="Original image"
                  style={{
                    clipPath:
                      viewMode === 'split'
                        ? `inset(0 ${100 - splitPosition}% 0 0)`
                        : 'inset(0 100% 0 0)',
                  }}
                />

                {viewMode === 'split' && (
                  <div
                    className="split-handle"
                    style={{ left: `${splitPosition}%` }}
                    aria-hidden="true"
                  />
                )}
              </div>
            )}

            {busy && (
              <div className="busy-overlay" role="status">
                <Loader2 size={22} />
              </div>
            )}
          </div>
        </section>
      </section>
    </main>
  );
}

export default App;
