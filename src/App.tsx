import { useEffect, useMemo, useRef, useState } from "react";
import JSZip from "jszip";
import { floodFillPixels, traceLinePixels, type PixelColor } from "./pixel-editor";

type Category = "블록" | "아이템" | "엔티티" | "인터페이스" | "갑옷" | "음식" | "도구" | "자연" | "지도" | "환경" | "효과" | "입자" | "기타";
type PackSettings = { name: string; description: string; version: string; minVersion?: string };
type EditorTool = "pencil" | "eraser" | "fill" | "eyedropper" | "line" | "rectangle" | "select";
type SelectionRect = { x: number; y: number; width: number; height: number };
type SelectionTransform = {
  mode: "create" | "move" | "resize";
  anchor: { x: number; y: number };
  origin: SelectionRect;
  handle?: string;
  source: HTMLCanvasElement | null;
};
type Asset = {
  id: string;
  name: string;
  koreanName: string;
  category: Category;
  path: string;
  blob: Blob;
  url: string;
  width?: number;
  height?: number;
};
type StoredAsset = Omit<Asset, "url">;

const TEXTURE_DB_NAME = "prism-resource-studio";
const TEXTURE_STORE_NAME = "textures";
const SETTINGS_STORE_NAME = "settings";
type DirectoryHandle = FileSystemDirectoryHandle & {
  values(): AsyncIterableIterator<FileSystemHandle>;
  queryPermission(options: { mode: "read" | "readwrite" }): Promise<PermissionState>;
  requestPermission(options: { mode: "read" | "readwrite" }): Promise<PermissionState>;
};
type InstalledVersion = { version: string; jar: File };

declare global {
  interface Window {
    prismDesktop?: {
      getMinecraftVersions(): Promise<string[]>;
      readMinecraftJar(version: string): Promise<ArrayBuffer>;
    };
  }
}

const assets: Asset[] = [];

const categoryOrder: Category[] = ["블록", "아이템", "엔티티", "인터페이스", "갑옷", "음식", "도구", "자연", "지도", "환경", "효과", "입자", "기타"];
const editorPalette = ["#ffffff", "#cfcfcf", "#999999", "#4c4c4c", "#111111", "#e7483d", "#f08030", "#f4d94e", "#8dcc55", "#39a66b", "#45b7d1", "#3676d9", "#7653c8", "#cb72bb", "#8b5a3c", "#f2c99b"];
const textureRoots: Record<string, Category> = {
  block: "블록", blocks: "블록", item: "아이템", items: "아이템",
  entity: "엔티티", entities: "엔티티", gui: "인터페이스", font: "인터페이스",
  map: "지도", environment: "환경", effect: "효과", particle: "입자",
};

function categoryForTexture(path: string): Category {
  const parts = path.split("/");
  const root = parts[0]?.toLowerCase() ?? "";
  const name = (parts.at(-1) ?? "").toLowerCase();
  const normalizedPath = parts.join("/").toLowerCase();
  if (normalizedPath.includes("/armor/") || normalizedPath.includes("/equipment/")) return "갑옷";
  if (root === "item" || root === "items") {
    if (/(apple|beef|chicken|cod|cookie|fish|food|mutton|pork|potato|rabbit|salmon|stew|melon_slice|carrot|bread)/.test(name)) return "음식";
    if (/(axe|bow|crossbow|fishing_rod|hoe|pickaxe|shield|shovel|sword|trident)/.test(name)) return "도구";
  }
  if ((root === "block" || root === "blocks") && /(azalea|bamboo|cactus|flower|fern|grass|leaves|log|mushroom|moss|roots|sapling|vine|lily|coral|seagrass)/.test(name)) return "자연";
  return textureRoots[root] ?? "기타";
}

function categoryFolder(category: string) {
  const folders: Record<string, string> = {
    블록: "block", 아이템: "item", 엔티티: "entity", 인터페이스: "gui",
    갑옷: "models/armor", 음식: "item", 도구: "item", 자연: "block",
    지도: "map", 환경: "environment", 효과: "effect", 입자: "particle", 기타: "misc",
  };
  return folders[category] ?? "block";
}

function fileNameWithoutExtension(filename: string) {
  return filename.replace(/\.(jar|zip)$/i, "");
}

function openTextureDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(TEXTURE_DB_NAME, 2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(TEXTURE_STORE_NAME)) {
        request.result.createObjectStore(TEXTURE_STORE_NAME, { keyPath: "path" });
      }
      if (!request.result.objectStoreNames.contains(SETTINGS_STORE_NAME)) {
        request.result.createObjectStore(SETTINGS_STORE_NAME, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("브라우저 텍스처 저장소를 열지 못했어요."));
  });
}

async function getSavedSetting<T>(key: string): Promise<T | undefined> {
  const database = await openTextureDatabase();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const request = database.transaction(SETTINGS_STORE_NAME, "readonly").objectStore(SETTINGS_STORE_NAME).get(key);
      request.onsuccess = () => resolve(request.result?.value as T | undefined);
      request.onerror = () => reject(request.error ?? new Error("저장된 설정을 읽지 못했어요."));
    });
  } finally {
    database.close();
  }
}

async function saveSetting(key: string, value: unknown) {
  const database = await openTextureDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const request = database.transaction(SETTINGS_STORE_NAME, "readwrite").objectStore(SETTINGS_STORE_NAME).put({ key, value });
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error("설정을 저장하지 못했어요."));
    });
  } finally {
    database.close();
  }
}

async function findMinecraftJars(root: FileSystemDirectoryHandle) {
  const result: InstalledVersion[] = [];
  let versionsDirectory: DirectoryHandle;
  try {
    versionsDirectory = await root.getDirectoryHandle("versions") as DirectoryHandle;
  } catch {
    throw new Error("선택한 폴더에서 versions 폴더를 찾을 수 없어요. .minecraft 폴더를 선택해 주세요.");
  }
  for await (const entry of versionsDirectory.values()) {
    if (entry.kind !== "directory") continue;
    try {
      const versionFolder = await versionsDirectory.getDirectoryHandle(entry.name);
      const jar = await versionFolder.getFileHandle(`${entry.name}.jar`);
      result.push({ version: entry.name, jar: await jar.getFile() });
    } catch {
      continue;
    }
  }
  return result.sort((left, right) => compareVersions(right.version, left.version));
}

function compareVersions(left: string, right: string) {
  const leftParts = left.split(/[.-]/).map((part) => Number(part) || 0);
  const rightParts = right.split(/[.-]/).map((part) => Number(part) || 0);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index++) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

async function loadSavedTextures() {
  const database = await openTextureDatabase();
  try {
    return await new Promise<Asset[]>((resolve, reject) => {
      const request = database.transaction(TEXTURE_STORE_NAME, "readonly").objectStore(TEXTURE_STORE_NAME).getAll();
      request.onsuccess = () => {
        const saved = request.result as StoredAsset[];
        resolve(saved.map((asset) => ({
          ...asset,
          category: categoryForTexture(asset.path),
          url: URL.createObjectURL(asset.blob),
        })));
      };
      request.onerror = () => reject(request.error ?? new Error("저장된 텍스처를 읽지 못했어요."));
    });
  } finally {
    database.close();
  }
}

async function saveTextureLibrary(textures: Asset[]) {
  const database = await openTextureDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(TEXTURE_STORE_NAME, "readwrite");
      const store = transaction.objectStore(TEXTURE_STORE_NAME);
      store.clear();
      for (const asset of textures) {
        const stored: StoredAsset = {
          id: asset.id,
          name: asset.name,
          koreanName: asset.koreanName,
          category: asset.category,
          path: asset.path,
          blob: asset.blob,
          width: asset.width,
          height: asset.height,
        };
        store.put(stored);
      }
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("텍스처 저장소를 열지 못했어요."));
      transaction.onabort = () => reject(transaction.error ?? new Error("텍스처 저장 공간이 부족하거나 저장이 취소되었어요."));
    });
  } finally {
    database.close();
  }
}

function textureEntries(zip: JSZip) {
  const prefixes = ["assets/minecraft/textures/", "minecraft/textures/", "textures/"];
  return Object.values(zip.files).filter((entry) =>
    !entry.dir && entry.name.toLowerCase().endsWith(".png") &&
    prefixes.some((prefix) => entry.name.toLowerCase().startsWith(prefix))
  );
}

function relativeTexturePath(entryName: string) {
  const normalized = entryName.replace(/\\/g, "/");
  const lower = normalized.toLowerCase();
  const marker = "textures/";
  const markerIndex = lower.lastIndexOf(marker);
  return markerIndex >= 0 ? normalized.slice(markerIndex + marker.length) : normalized.split("/").pop() ?? "texture.png";
}

const initialPack: PackSettings = {
  name: "나만의 리소스팩",
  description: "Prism으로 만든 나만의 Minecraft 리소스팩",
  version: "26.3",
  minVersion: "1.6.1",
};

const minecraftVersions = [
  { version: "26.3", packFormat: 97.1 },
  { version: "26.2", packFormat: 88 },
  { version: "26.1", packFormat: 84 },
  { version: "1.21.11", packFormat: 75 },
  { version: "1.21.10", packFormat: 69 },
  { version: "1.21.9", packFormat: 69 },
  { version: "1.21.8", packFormat: 64 },
  { version: "1.21.7", packFormat: 64 },
  { version: "1.21.6", packFormat: 63 },
  { version: "1.21.5", packFormat: 55 },
  { version: "1.21.4", packFormat: 46 },
  { version: "1.21.3", packFormat: 42 },
  { version: "1.21.2", packFormat: 42 },
  { version: "1.21.1", packFormat: 34 },
  { version: "1.21", packFormat: 34 },
  { version: "1.20.6", packFormat: 32 },
  { version: "1.20.5", packFormat: 32 },
  { version: "1.20.4", packFormat: 22 },
  { version: "1.20.3", packFormat: 22 },
  { version: "1.20.2", packFormat: 18 },
  { version: "1.20.1", packFormat: 15 },
  { version: "1.20", packFormat: 15 },
  { version: "1.19.4", packFormat: 13 },
  { version: "1.19.3", packFormat: 12 },
  { version: "1.19.2", packFormat: 9 },
  { version: "1.19.1", packFormat: 9 },
  { version: "1.19", packFormat: 9 },
  { version: "1.18.2", packFormat: 8 },
  { version: "1.18.1", packFormat: 8 },
  { version: "1.18", packFormat: 8 },
  { version: "1.17.1", packFormat: 7 },
  { version: "1.17", packFormat: 7 },
  { version: "1.16.5", packFormat: 6 },
  { version: "1.16.4", packFormat: 6 },
  { version: "1.16.3", packFormat: 6 },
  { version: "1.16.2", packFormat: 6 },
  { version: "1.16.1", packFormat: 5 },
  { version: "1.16", packFormat: 5 },
  { version: "1.15.2", packFormat: 5 },
  { version: "1.15.1", packFormat: 5 },
  { version: "1.15", packFormat: 5 },
  { version: "1.14.4", packFormat: 4 },
  { version: "1.14.3", packFormat: 4 },
  { version: "1.14.2", packFormat: 4 },
  { version: "1.14.1", packFormat: 4 },
  { version: "1.14", packFormat: 4 },
  { version: "1.13.2", packFormat: 4 },
  { version: "1.13.1", packFormat: 4 },
  { version: "1.13", packFormat: 4 },
  { version: "1.12.2", packFormat: 3 },
  { version: "1.12.1", packFormat: 3 },
  { version: "1.12", packFormat: 3 },
  { version: "1.11.2", packFormat: 3 },
  { version: "1.11", packFormat: 3 },
  { version: "1.10.2", packFormat: 2 },
  { version: "1.10", packFormat: 2 },
  { version: "1.9.4", packFormat: 2 },
  { version: "1.9", packFormat: 2 },
  { version: "1.8.9", packFormat: 1 },
  { version: "1.8", packFormat: 1 },
  { version: "1.7.10", packFormat: 1 },
  { version: "1.6.4", packFormat: 1 },
  { version: "1.6.1", packFormat: 1 },
];

function isPackSettings(value: unknown): value is PackSettings {
  return typeof value === "object" && value !== null &&
    "name" in value && typeof value.name === "string" &&
    "description" in value && typeof value.description === "string" &&
    "version" in value && typeof value.version === "string" &&
    (!("minVersion" in value) || typeof value.minVersion === "string");
}

function Icon({ name, size = 16 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    search: <><circle cx="10.8" cy="10.8" r="6.4" /><path d="m16 16 4 4" /></>,
    upload: <><path d="M12 16V4m0 0L7 9m5-5 5 5" /><path d="M5 14v5h14v-5" /></>,
    download: <><path d="M12 4v12m0 0 5-5m-5 5-5-5" /><path d="M5 18v2h14v-2" /></>,
    folder: <><path d="M3 6h7l2 2h9v10H3z" /><path d="M3 9h18" /></>,
    grid: <><rect x="4" y="4" width="6" height="6" rx="1" /><rect x="14" y="4" width="6" height="6" rx="1" /><rect x="4" y="14" width="6" height="6" rx="1" /><rect x="14" y="14" width="6" height="6" rx="1" /></>,
    plus: <><path d="M12 5v14M5 12h14" /></>,
    pencil: <><path d="m15 5 4 4M4 20l4-.8L19 8a2.1 2.1 0 0 0-3-3L5 16z" /><path d="M4 20h16" /></>,
    copy: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></>,
    settings: <><path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z" /><path d="m19.4 15 .1.1 1.4 1.1-1.4 2.4-1.7-.7a8 8 0 0 1-1.7 1l-.3 1.8h-2.8l-.3-1.8a8 8 0 0 1-1.7-1l-1.7.7-1.4-2.4 1.4-1.1a7 7 0 0 1 0-2l-1.4-1.1 1.4-2.4 1.7.7a8 8 0 0 1 1.7-1l.3-1.8h2.8l.3 1.8a8 8 0 0 1 1.7 1l1.7-.7 1.4 2.4-1.4 1.1a7 7 0 0 1 0 2z" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    spark: <><path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" /><path d="m19 15 .8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" /></>,
    close: <><path d="m6 6 12 12M18 6 6 18" /></>,
    chevron: <path d="m8 10 4 4 4-4" />,
    cube: <><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9z" /><path d="m12 12 8-4.5M12 12v9m0-9L4 7.5" /></>,
    info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5m0-8h.01" /></>,
    trash: <><path d="M4 7h16M10 11v6m4-6v6M5 7l1 13h12l1-13M9 7V4h6v3" /></>,
    undo: <><path d="M9 14 4 9l5-5" /><path d="M4 9h9a7 7 0 0 1 0 14h-2" /></>,
    redo: <><path d="m15 14 5-5-5-5" /><path d="M20 9h-9a7 7 0 0 0 0 14h2" /></>,
    scissors: <><circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="m8.1 8.1 12 12M14 10l6-6M8.1 15.9 12 12" /></>,
    paste: <><rect x="5" y="5" width="14" height="16" rx="2" /><path d="M9 5.2V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v1.2M9 11h6m-6 4h6" /></>,
    eraser: <><path d="m7 21-4-4a2 2 0 0 1 0-3l9-9a2 2 0 0 1 3 0l6 6a2 2 0 0 1 0 3l-7 7z" /><path d="m5 13 6 6M12 21h9" /></>,
    bucket: <><path d="m19 11-7-7-9 9 7 7z" /><path d="m9 6 7 7M14 16h.01" /><path d="M20 16c0 2-1.5 4-3 5-1.5-1-3-3-3-5a3 3 0 0 1 6 0z" /></>,
    eyedropper: <><path d="m2 22 1-1h3l9-9" /><path d="m3 21 9-9" /><path d="m14 7 3-3a2.8 2.8 0 0 1 4 4l-3 3" /><path d="m11 10 3-3 5 5-3 3z" /></>,
    line: <path d="m5 19 14-14" />,
    rectangle: <rect x="4" y="5" width="16" height="14" rx="1" />,
    select: <><rect x="4" y="4" width="16" height="16" rx="1" strokeDasharray="3 2" /><path d="M8 8h.01M16 8h.01M8 16h.01M16 16h.01" /></>,
    zoomIn: <><circle cx="10.8" cy="10.8" r="6.4" /><path d="m16 16 4 4M10.8 7.8v6m-3-3h6" /></>,
    zoomOut: <><circle cx="10.8" cy="10.8" r="6.4" /><path d="m16 16 4 4m-12-9h6" /></>,
    checker: <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h6v6H3zm12 0h6v6h-6zM9 3h6v6H9zm0 12h6v6H9z" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] ?? paths.cube}</svg>;
}

function PixelSprite({ asset, size = 56, onLoad }: { asset: Asset; size?: number; onLoad?: (event: React.SyntheticEvent<HTMLImageElement>) => void }) {
  return <img className="uploaded-sprite" src={asset.url} alt="" onLoad={onLoad} style={{ width: size, height: size }} />;
}

const categoryIcons: Partial<Record<Category, string>> = { 블록: "cube", 아이템: "spark", 엔티티: "cube", 인터페이스: "grid", 갑옷: "grid", 자연: "spark", 지도: "grid", 입자: "spark" };

function App() {
  const [pack, setPack] = useState(initialPack);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [minecraftFolderName, setMinecraftFolderName] = useState("");
  const [outputFolder, setOutputFolder] = useState<DirectoryHandle | null>(null);
  const [outputFolderName, setOutputFolderName] = useState("");
  const [installedVersions, setInstalledVersions] = useState<InstalledVersion[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [category, setCategory] = useState("전체");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [zoom, setZoom] = useState(4);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorColor, setEditorColor] = useState("#c6fa78");
  const [editorPath, setEditorPath] = useState("");
  const [editorTool, setEditorTool] = useState<EditorTool>("pencil");
  const [editorZoom, setEditorZoom] = useState(12);
  const [editorBrushSize, setEditorBrushSize] = useState(1);
  const [editorOpacity, setEditorOpacity] = useState(100);
  const [editorGrid, setEditorGrid] = useState(true);
  const [editorDimensions, setEditorDimensions] = useState({ width: 0, height: 0 });
  const [editorSelection, setEditorSelection] = useState<SelectionRect | null>(null);
  const [editorClipboard, setEditorClipboard] = useState<ImageData | null>(null);
  const [undoCount, setUndoCount] = useState(0);
  const [redoCount, setRedoCount] = useState(0);
  const [sortMode, setSortMode] = useState<"최신순" | "가나다순">("최신순");
  const [toast, setToast] = useState("");
  const [imported, setImported] = useState<Asset[]>([]);
  const [edited, setEdited] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const vanillaInput = useRef<HTMLInputElement>(null);
  const manualJarInput = useRef<HTMLInputElement>(null);
  const replaceInput = useRef<HTMLInputElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const editorCanvas = useRef<HTMLCanvasElement>(null);
  const editorPreviewCanvas = useRef<HTMLCanvasElement>(null);
  const editorUndoStack = useRef<ImageData[]>([]);
  const editorRedoStack = useRef<ImageData[]>([]);
  const drawing = useRef(false);
  const editorStart = useRef<{ x: number; y: number } | null>(null);
  const editorEnd = useRef<{ x: number; y: number } | null>(null);
  const editorLastPixel = useRef<{ x: number; y: number } | null>(null);
  const selectionTransform = useRef<SelectionTransform | null>(null);
  const selectionImage = useRef<HTMLCanvasElement | null>(null);

  const allAssets = useMemo(() => [...imported, ...assets], [imported]);
  const visibleAssets = useMemo(() => {
    const filtered = allAssets.filter((asset) =>
      (category === "전체" || asset.category === category) &&
      `${asset.name} ${asset.koreanName}`.toLowerCase().includes(query.trim().toLowerCase())
    );
    return sortMode === "가나다순"
      ? filtered.sort((left, right) => left.koreanName.localeCompare(right.koreanName, "ko"))
      : filtered;
  }, [allAssets, category, query, sortMode]);
  const selected = allAssets.find((asset) => asset.id === selectedId) ?? allAssets[0];
  const packAssets = useMemo(() => allAssets.filter((asset) => edited.has(asset.id)), [allAssets, edited]);
  const editedCount = packAssets.length;
  const versionGroups = useMemo(() => {
    const prefixes = ["26.", "1.21", "1.20", "1.19", "1.18", "1.17", "1.16", "1.15", "1.14", "1.13", "1.12", "1.11", "1.10", "1.9", "1.8", "1.7", "1.6"];
    return prefixes.map((prefix) => ({
      label: prefix.endsWith(".") ? `${prefix.slice(0, -1)}.x 계열` : `${prefix}.x 계열`,
      versions: minecraftVersions.filter(({ version }) => prefix === "26." ? version.startsWith(prefix) : version === prefix || version.startsWith(`${prefix}.`)),
    })).filter((group) => group.versions.length > 0);
  }, []);
  const selectedVersionInfo = minecraftVersions.find((item) => item.version === pack.version);

  function notify(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(""), 2600);
  }

  async function chooseMinecraftFolder() {
    const picker = (window as Window & {
      showDirectoryPicker?: (options?: { mode: "read" | "readwrite" }) => Promise<FileSystemDirectoryHandle>;
    }).showDirectoryPicker;
    if (!picker) {
      notify("이 브라우저는 폴더 선택을 지원하지 않아 JAR 파일 찾기를 열어요.");
      manualJarInput.current?.click();
      return;
    }
    try {
      const handle = await picker({ mode: "read" }) as DirectoryHandle;
      const versions = await findMinecraftJars(handle);
      if (!versions.length) throw new Error(".minecraft/versions 안에 설치된 버전 JAR이 없어요.");
      await saveSetting("minecraft-directory", handle);
      setMinecraftFolderName(handle.name);
      setInstalledVersions(versions);
      const target = versions.find((item) => item.version === pack.version) ?? versions[0];
      setPack((current) => ({
        ...current,
        version: target.version,
        minVersion: compareVersions(current.minVersion ?? "1.6.1", target.version) > 0 ? target.version : current.minVersion ?? "1.6.1",
      }));
      await importFiles([target.jar], "vanilla");
      notify(`Minecraft ${target.version}를 자동으로 찾았어요`);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      notify(error instanceof Error ? `Minecraft 폴더를 찾지 못했어요: ${error.message}` : "Minecraft 폴더를 찾지 못했어요");
    }
  }

  async function chooseManualMinecraftJar(file: File | undefined) {
    if (!file) return;
    const version = file.name.replace(/\.jar$/i, "");
    setInstalledVersions((current) => [
      { version, jar: file },
      ...current.filter((item) => item.version !== version),
    ]);
    if (minecraftVersions.some((item) => item.version === version)) {
      setPack((current) => ({ ...current, version }));
    }
    await importFiles([file], "vanilla");
    if (manualJarInput.current) manualJarInput.current.value = "";
  }

  async function chooseOutputFolder() {
    const picker = (window as Window & {
      showDirectoryPicker?: (options?: { mode: "read" | "readwrite" }) => Promise<FileSystemDirectoryHandle>;
    }).showDirectoryPicker;
    if (!picker) {
      notify("이 브라우저는 폴더 선택을 지원하지 않아요. 다운로드 폴더를 사용해 주세요.");
      return;
    }
    try {
      const handle = await picker({ mode: "readwrite" }) as DirectoryHandle;
      await saveSetting("output-directory", handle);
      setOutputFolder(handle);
      setOutputFolderName(handle.name);
      notify(`${handle.name} 폴더를 팩 저장 위치로 선택했어요`);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      notify(error instanceof Error ? `저장 폴더를 선택하지 못했어요: ${error.message}` : "저장 폴더를 선택하지 못했어요");
    }
  }

  async function useDownloadsFolder() {
    try {
      await saveSetting("output-directory", null);
      setOutputFolder(null);
      setOutputFolderName("");
      notify(window.prismDesktop ? "팩을 앱 다운로드 폴더에 저장합니다" : "팩을 브라우저 다운로드 폴더에 저장합니다");
    } catch (error) {
      notify(error instanceof Error ? `다운로드 위치를 저장하지 못했어요: ${error.message}` : "다운로드 위치를 저장하지 못했어요");
    }
  }

  async function writePackFile(blob: Blob, filename: string) {
    if (!outputFolder) {
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      return "다운로드";
    }

    let permission = await outputFolder.queryPermission({ mode: "readwrite" });
    if (permission !== "granted") permission = await outputFolder.requestPermission({ mode: "readwrite" });
    if (permission !== "granted") throw new Error("선택한 폴더에 저장할 권한이 없어 다운로드 폴더로 저장하지 못했어요.");
    const fileHandle = await outputFolder.getFileHandle(filename, { create: true });
    const writable = await fileHandle.createWritable();
    try {
      await writable.write(blob);
      await writable.close();
    } catch (error) {
      await writable.abort();
      throw error;
    }
    return outputFolder.name;
  }

  useEffect(() => {
    let cancelled = false;
    async function restoreProject() {
      let savedIds: string[] = [];
      let savedPack: PackSettings = initialPack;
      try {
        const savedPackJson = localStorage.getItem("prism-pack");
        if (savedPackJson) {
          const parsed: unknown = JSON.parse(savedPackJson);
          if (!isPackSettings(parsed)) throw new Error("팩 설정 형식이 올바르지 않습니다.");
          savedPack = { ...initialPack, ...parsed };
          setPack(savedPack);
        }
        const savedAssets = localStorage.getItem("prism-edited");
        if (savedAssets) {
          const parsed: unknown = JSON.parse(savedAssets);
          if (!Array.isArray(parsed) || !parsed.every((id) => typeof id === "string")) {
            throw new Error("저장된 리소스 목록 형식이 올바르지 않습니다.");
          }
          savedIds = parsed;
        }
      } catch (error) {
        notify(error instanceof Error ? `저장된 프로젝트 설정을 불러오지 못했어요: ${error.message}` : "저장된 프로젝트 설정을 불러오지 못했어요");
      }

      let savedTextures: Asset[] = [];
      try {
        savedTextures = await loadSavedTextures();
        if (cancelled) {
          savedTextures.forEach((asset) => URL.revokeObjectURL(asset.url));
          return;
        }
        setImported(savedTextures);
        setEdited(new Set(savedIds.filter((id) => savedTextures.some((asset) => asset.id === id))));
        if (savedTextures.length) setSelectedId(savedTextures[0].id);
      } catch (error) {
        notify(error instanceof Error ? `저장된 텍스처를 불러오지 못했어요: ${error.message}` : "저장된 텍스처를 불러오지 못했어요");
      }

      const desktop = window.prismDesktop;
      if (desktop) {
        try {
          const versions = await desktop.getMinecraftVersions();
          if (cancelled) return;
          const installed = versions.map((version) => ({
            version,
            jar: new File([], `${version}.jar`, { type: "application/java-archive" }),
          }));
          setInstalledVersions(installed);
          const target = installed.find((item) => item.version === savedPack.version) ?? installed[0];
          if (!target) {
            notify("Minecraft 설치 파일(.jar)을 찾지 못했어요. Minecraft Java Edition을 설치하고 게임을 한 번 실행해 주세요.");
            return;
          }
          setMinecraftFolderName(".minecraft");
          const preservedEdits = savedTextures.filter((asset) => savedIds.includes(asset.id));
          await importInstalledVersion(target, preservedEdits);
          if (minecraftVersions.some((item) => item.version === target.version)) {
            setPack((current) => ({
              ...current,
              version: target.version,
              minVersion: compareVersions(current.minVersion ?? "1.6.1", target.version) > 0
                ? target.version
                : current.minVersion ?? "1.6.1",
            }));
          }
        } catch (error) {
          notify(error instanceof Error ? `Minecraft 설치 파일을 자동으로 불러오지 못했어요: ${error.message}` : "Minecraft 설치 파일을 자동으로 불러오지 못했어요");
        }
        return;
      }

      try {
        const minecraftDirectory = await getSavedSetting<DirectoryHandle>("minecraft-directory");
        const savedOutput = await getSavedSetting<DirectoryHandle>("output-directory");
        if (savedOutput) {
          setOutputFolder(savedOutput);
          setOutputFolderName(savedOutput.name);
        }
        if (minecraftDirectory) {
          setMinecraftFolderName(minecraftDirectory.name);
          const permission = await minecraftDirectory.queryPermission({ mode: "read" });
          if (permission === "granted") {
            const versions = await findMinecraftJars(minecraftDirectory);
            if (!cancelled) {
              setInstalledVersions(versions);
              const target = versions.find((item) => item.version === savedPack.version) ?? versions[0];
              if (target) {
                if (minecraftVersions.some((item) => item.version === target.version)) {
                  setPack((current) => ({ ...current, version: target.version }));
                }
                await importFiles([target.jar], "vanilla");
              } else {
                setSettingsOpen(true);
              }
            }
          } else {
            setSettingsOpen(true);
          }
        } else {
          setSettingsOpen(true);
        }
      } catch (error) {
        notify(error instanceof Error ? `Minecraft 폴더를 자동으로 찾지 못했어요: ${error.message}` : "Minecraft 폴더를 자동으로 찾지 못했어요");
        setSettingsOpen(true);
      }
    }
    void restoreProject();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    function handleShortcut(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchInput.current?.focus();
      }
    }
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, []);

  useEffect(() => {
    if (!editorOpen) return;
    function handleEditorShortcut(event: KeyboardEvent) {
      const target = event.target;
      if (target instanceof HTMLElement && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redoEditorAction();
        else undoEditorAction();
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
        event.preventDefault();
        redoEditorAction();
      } else if (event.key === "Escape") {
        setEditorOpen(false);
      } else if (!event.ctrlKey && !event.metaKey) {
        const shortcuts: Record<string, EditorTool> = { b: "pencil", e: "eraser", g: "fill", i: "eyedropper", l: "line", u: "rectangle", m: "select" };
        const tool = shortcuts[event.key.toLowerCase()];
        if (tool) {
          event.preventDefault();
          setEditorTool(tool);
        }
      }
    }
    window.addEventListener("keydown", handleEditorShortcut);
    return () => window.removeEventListener("keydown", handleEditorShortcut);
  }, [editorOpen]);

  useEffect(() => {
    if (!editorOpen || !selected || !editorCanvas.current) return;
    const canvas = editorCanvas.current;
    const previewCanvas = editorPreviewCanvas.current;
    setEditorDimensions({ width: 0, height: 0 });
    const image = new Image();
    image.onload = () => {
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      setEditorDimensions({ width: canvas.width, height: canvas.height });
      if (previewCanvas) {
        previewCanvas.width = image.naturalWidth;
        previewCanvas.height = image.naturalHeight;
      }
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) {
        notify("텍스처 편집 캔버스를 초기화하지 못했어요.");
        return;
      }
      context.imageSmoothingEnabled = false;
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0);
      editorUndoStack.current = [];
      editorRedoStack.current = [];
      setEditorSelection(null);
      setEditorClipboard(null);
      selectionTransform.current = null;
      selectionImage.current = null;
      setUndoCount(0);
      setRedoCount(0);
      setEditorZoom(Math.max(1, Math.min(24, Math.floor(520 / Math.max(image.naturalWidth, image.naturalHeight)))));
      drawing.current = false;
    };
    image.onerror = () => notify("선택한 PNG 텍스처를 편집기로 불러오지 못했어요.");
    image.src = selected.url;
  }, [editorOpen, selected?.url]);

  function updatePack(key: "name" | "description" | "version" | "minVersion", value: string) {
    setPack((current) => ({ ...current, [key]: value }));
  }

  function choosePackVersion(value: string) {
    setPack((current) => ({
      ...current,
      version: value,
      minVersion: compareVersions(current.minVersion ?? "1.6.1", value) > 0 ? value : current.minVersion ?? "1.6.1",
    }));
    const installed = installedVersions.find((item) => item.version === value);
    if (installed) void importInstalledVersion(installed);
  }

  async function importInstalledVersion(installed: InstalledVersion, preservedEdits?: Asset[]) {
    try {
      if (window.prismDesktop) {
        const buffer = await window.prismDesktop.readMinecraftJar(installed.version);
        await importFiles(
          [new File([buffer], `${installed.version}.jar`, { type: "application/java-archive" })],
          "vanilla",
          preservedEdits,
        );
        return;
      }
      await importFiles([installed.jar], "vanilla", preservedEdits);
    } catch (error) {
      notify(error instanceof Error ? `Minecraft ${installed.version} 파일을 불러오지 못했어요: ${error.message}` : "Minecraft 파일을 불러오지 못했어요");
    }
  }

  function saveProject() {
    try {
      localStorage.setItem("prism-pack", JSON.stringify(pack));
      localStorage.setItem("prism-edited", JSON.stringify([...edited]));
      notify("프로젝트를 이 컴퓨터에 저장했어요");
      return true;
    } catch (error) {
      notify(error instanceof Error ? `프로젝트를 저장하지 못했어요: ${error.message}` : "프로젝트를 저장하지 못했어요");
      return false;
    }
  }

  async function importFiles(files: FileList | File[] | null, kind: "vanilla" | "pack", preservedEdits?: Asset[]) {
    if (!files?.length) return;
    setLoading(true);
    try {
      const additions: Asset[] = [];
      for (const file of Array.from(files)) {
        if (/\.(jar|zip)$/i.test(file.name)) {
          const zip = await JSZip.loadAsync(file);
          for (const entry of textureEntries(zip)) {
            const blob = await entry.async("blob");
            additions.push(makeImportedAsset(relativeTexturePath(entry.name), blob));
          }
        } else if (file.type === "image/png" || file.name.toLowerCase().endsWith(".png")) {
          if (kind === "vanilla") throw new Error("Minecraft Java .jar 또는 리소스팩 .zip 파일을 선택해 주세요.");
          const fallback = selected?.path ?? `${category === "전체" ? "block" : categoryFolder(category)}/`;
          const path = fallback.includes("/") ? `${fallback.slice(0, fallback.lastIndexOf("/") + 1)}${file.name}` : `${fallback}/${file.name}`;
          additions.push(makeImportedAsset(path, file));
        } else {
          throw new Error(`${file.name}: Minecraft .jar, 리소스팩 .zip 또는 PNG 파일을 선택해 주세요.`);
        }
      }
      if (!additions.length) throw new Error("assets/minecraft/textures 폴더의 PNG 텍스처를 찾지 못했어요.");
      const uniqueAdditions = [...new Map(additions.map((asset) => [asset.path, asset])).values()];
      if (kind === "vanilla") {
        const preserved = preservedEdits ?? imported.filter((asset) => edited.has(asset.id));
        const mergedByPath = new Map(uniqueAdditions.map((asset) => [asset.path, asset]));
        for (const asset of preserved) mergedByPath.set(asset.path, asset);
        const merged = [...mergedByPath.values()];
        setImported(merged);
        setEdited((current) => new Set([...current, ...preserved.map((asset) => asset.id)].filter((id) => merged.some((asset) => asset.id === id))));
        void saveTextureLibrary(merged).catch((error: unknown) => notify(error instanceof Error ? `불러온 텍스처를 저장소에 저장하지 못했어요: ${error.message}` : "불러온 텍스처를 저장소에 저장하지 못했어요"));
      } else {
        const byPath = new Map(imported.map((asset) => [asset.path, asset]));
        for (const asset of uniqueAdditions) byPath.set(asset.path, asset);
        const merged = [...byPath.values()];
        setImported(merged);
        setEdited((current) => new Set([...current, ...uniqueAdditions.map((asset) => asset.id)]));
        void saveTextureLibrary(merged).catch((error: unknown) => notify(error instanceof Error ? `가져온 텍스처를 저장소에 저장하지 못했어요: ${error.message}` : "가져온 텍스처를 저장소에 저장하지 못했어요"));
      }
      setCategory("전체");
      setSearch("");
      setQuery("");
      setSelectedId(uniqueAdditions[0].id);
      notify(kind === "vanilla"
        ? `${fileNameWithoutExtension(files[0].name)} 기본 텍스처 ${uniqueAdditions.length}개를 불러왔어요`
        : `${uniqueAdditions.length}개의 텍스처를 가져왔어요`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "파일을 가져오지 못했어요");
    } finally {
      setLoading(false);
      if (fileInput.current) fileInput.current.value = "";
      if (vanillaInput.current) vanillaInput.current.value = "";
    }
  }

  function makeImportedAsset(path: string, blob: Blob): Asset {
    const filename = path.split("/").pop() ?? path;
    const name = filename.replace(/\.png$/i, "");
    return {
      id: path.toLowerCase(),
      name,
      koreanName: name.replace(/[_-]+/g, " "),
      category: categoryForTexture(path),
      path,
      blob,
      url: URL.createObjectURL(blob),
    };
  }

  function replaceSelectedTexture(file: File | undefined) {
    if (!selected || !file) return;
    if (file.type !== "image/png" && !file.name.toLowerCase().endsWith(".png")) {
      notify("PNG 이미지 파일만 텍스처로 교체할 수 있어요.");
      return;
    }
    const replacement = { ...makeImportedAsset(selected.path, file), width: selected.width, height: selected.height };
    const byPath = new Map(imported.map((asset) => [asset.path, asset]));
    byPath.set(replacement.path, replacement);
    const updated = [...byPath.values()];
    setImported(updated);
    void saveTextureLibrary(updated).catch((error: unknown) => notify(error instanceof Error ? `교체한 텍스처를 저장소에 저장하지 못했어요: ${error.message}` : "교체한 텍스처를 저장소에 저장하지 못했어요"));
    setEdited((current) => new Set([...current, replacement.id]));
    setSelectedId(replacement.id);
    notify(`${replacement.path} 텍스처를 교체했어요`);
    if (replaceInput.current) replaceInput.current.value = "";
  }

  async function deleteSelectedTexture() {
    if (!selected) return;
    if (!window.confirm(`"${selected.name}" 텍스처를 라이브러리에서 삭제할까요?`)) return;
    const updated = imported.filter((asset) => asset.id !== selected.id);
    if (updated.length === imported.length) {
      notify("이 텍스처는 기본 라이브러리에서 삭제할 수 없어요.");
      return;
    }
    try {
      await saveTextureLibrary(updated);
      setImported(updated);
      setEdited((current) => {
        const next = new Set(current);
        next.delete(selected.id);
        return next;
      });
      setSelectedId(updated[0]?.id ?? "");
      URL.revokeObjectURL(selected.url);
      notify(`${selected.name} 텍스처를 삭제했어요`);
    } catch (error) {
      notify(error instanceof Error ? `텍스처를 삭제하지 못했어요: ${error.message}` : "텍스처를 삭제하지 못했어요");
    }
  }

  function openTextureEditor() {
    if (!selected) {
      notify("먼저 텍스처 라이브러리를 불러와 주세요.");
      return;
    }
    setEditorPath(selected.path);
    setEditorDimensions({ width: 0, height: 0 });
    setEditorOpen(true);
  }

  function updateEditorHistoryCounts() {
    setUndoCount(editorUndoStack.current.length);
    setRedoCount(editorRedoStack.current.length);
  }

  function saveEditorUndoFrame() {
    const canvas = editorCanvas.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    editorUndoStack.current.push(context.getImageData(0, 0, canvas.width, canvas.height));
    if (editorUndoStack.current.length > 30) editorUndoStack.current.shift();
    editorRedoStack.current = [];
    updateEditorHistoryCounts();
  }

  function undoEditorAction() {
    const canvas = editorCanvas.current;
    const context = canvas?.getContext("2d");
    const previous = editorUndoStack.current.pop();
    if (!canvas || !context || !previous) return;
    editorRedoStack.current.push(context.getImageData(0, 0, canvas.width, canvas.height));
    context.putImageData(previous, 0, 0);
    editorPreviewCanvas.current?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
    setEditorSelection(null);
    updateEditorHistoryCounts();
  }

  function redoEditorAction() {
    const canvas = editorCanvas.current;
    const context = canvas?.getContext("2d");
    const next = editorRedoStack.current.pop();
    if (!canvas || !context || !next) return;
    editorUndoStack.current.push(context.getImageData(0, 0, canvas.width, canvas.height));
    context.putImageData(next, 0, 0);
    setEditorSelection(null);
    updateEditorHistoryCounts();
  }

  function editorCoordinates(event: React.PointerEvent<HTMLCanvasElement>) {
    return editorPointFromClient(event.clientX, event.clientY);
  }

  function editorPointFromClient(clientX: number, clientY: number) {
    const canvas = editorCanvas.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor((clientX - rect.left) * canvas.width / rect.width);
    const y = Math.floor((clientY - rect.top) * canvas.height / rect.height);
    if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return null;
    return { x, y };
  }

  function drawSelectionPreview(image: HTMLCanvasElement, rect: SelectionRect) {
    const preview = editorPreviewCanvas.current?.getContext("2d");
    const previewCanvas = editorPreviewCanvas.current;
    if (!preview || !previewCanvas) return;
    preview.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
    preview.drawImage(image, 0, 0, image.width, image.height, rect.x, rect.y, rect.width, rect.height);
  }

  function startSelectionMove(point: { x: number; y: number }, selection: SelectionRect) {
    const canvas = editorCanvas.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return false;
    const imageData = context.getImageData(selection.x, selection.y, selection.width, selection.height);
    const image = document.createElement("canvas");
    image.width = selection.width;
    image.height = selection.height;
    image.getContext("2d")?.putImageData(imageData, 0, 0);
    saveEditorUndoFrame();
    context.clearRect(selection.x, selection.y, selection.width, selection.height);
    selectionImage.current = image;
    selectionTransform.current = { mode: "move", anchor: point, origin: selection, source: image };
    drawing.current = true;
    drawSelectionPreview(image, selection);
    return true;
  }

  function handleSelectionResizeStart(event: React.PointerEvent<HTMLButtonElement>, handle: string) {
    event.stopPropagation();
    const selection = editorSelection;
    const canvas = editorCanvas.current;
    const context = canvas?.getContext("2d");
    const point = editorPointFromClient(event.clientX, event.clientY);
    if (!selection || !canvas || !context || !point) return;
    const imageData = context.getImageData(selection.x, selection.y, selection.width, selection.height);
    const image = document.createElement("canvas");
    image.width = selection.width;
    image.height = selection.height;
    image.getContext("2d")?.putImageData(imageData, 0, 0);
    saveEditorUndoFrame();
    context.clearRect(selection.x, selection.y, selection.width, selection.height);
    selectionImage.current = image;
    selectionTransform.current = { mode: "resize", anchor: point, origin: selection, handle, source: image };
    drawing.current = true;
    drawSelectionPreview(image, selection);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function updateSelectionResize(clientX: number, clientY: number) {
    const transform = selectionTransform.current;
    const canvas = editorCanvas.current;
    const image = selectionImage.current;
    if (!transform || transform.mode !== "resize" || !transform.handle || !canvas || !image) return;
    const point = editorPointFromClient(clientX, clientY);
    if (!point) return;
    const { origin, anchor, handle } = transform;
    let left = origin.x;
    let top = origin.y;
    let right = origin.x + origin.width;
    let bottom = origin.y + origin.height;
    const dx = point.x - anchor.x;
    const dy = point.y - anchor.y;
    if (handle.includes("w")) left = Math.min(right - 1, Math.max(0, origin.x + dx));
    if (handle.includes("e")) right = Math.max(left + 1, Math.min(canvas.width, origin.x + origin.width + dx));
    if (handle.includes("n")) top = Math.min(bottom - 1, Math.max(0, origin.y + dy));
    if (handle.includes("s")) bottom = Math.max(top + 1, Math.min(canvas.height, origin.y + origin.height + dy));
    const rect = { x: left, y: top, width: right - left, height: bottom - top };
    setEditorSelection(rect);
    drawSelectionPreview(image, rect);
  }

  function finishSelectionTransform() {
    const transform = selectionTransform.current;
    const canvas = editorCanvas.current;
    const context = canvas?.getContext("2d");
    const previewCanvas = editorPreviewCanvas.current;
    const previewContext = previewCanvas?.getContext("2d");
    if (transform && context && previewCanvas && previewContext && transform.mode !== "create") {
      context.drawImage(previewCanvas, 0, 0);
      previewContext.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
    }
    drawing.current = false;
    editorStart.current = null;
    editorEnd.current = null;
    editorLastPixel.current = null;
    selectionTransform.current = null;
    selectionImage.current = null;
  }

  function copyEditorSelection(remove = false) {
    const selection = editorSelection;
    const canvas = editorCanvas.current;
    const context = canvas?.getContext("2d");
    if (!selection || !context) return;
    const image = context.getImageData(selection.x, selection.y, selection.width, selection.height);
    setEditorClipboard(image);
    if (remove) {
      saveEditorUndoFrame();
      context.clearRect(selection.x, selection.y, selection.width, selection.height);
      setEditorSelection(null);
    }
  }

  function pasteEditorSelection() {
    const clipboard = editorClipboard;
    const canvas = editorCanvas.current;
    const context = canvas?.getContext("2d");
    if (!clipboard || !canvas || !context) return;
    saveEditorUndoFrame();
    const x = Math.min(canvas.width - 1, Math.max(0, editorSelection?.x ?? 0));
    const y = Math.min(canvas.height - 1, Math.max(0, editorSelection?.y ?? 0));
    context.putImageData(clipboard, x, y);
    setEditorSelection({
      x,
      y,
      width: Math.min(clipboard.width, canvas.width - x),
      height: Math.min(clipboard.height, canvas.height - y),
    });
  }

  function deleteEditorSelection() {
    const selection = editorSelection;
    const canvas = editorCanvas.current;
    const context = canvas?.getContext("2d");
    if (!selection || !canvas || !context) return;
    saveEditorUndoFrame();
    context.clearRect(selection.x, selection.y, selection.width, selection.height);
    editorPreviewCanvas.current?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
    setEditorSelection(null);
  }

  function drawEditorBrush(context: CanvasRenderingContext2D, x: number, y: number) {
    const offset = Math.floor(editorBrushSize / 2);
    context.globalAlpha = editorOpacity / 100;
    if (editorTool === "eraser") {
      context.globalCompositeOperation = "destination-out";
      context.fillRect(x - offset, y - offset, editorBrushSize, editorBrushSize);
      context.globalCompositeOperation = "source-over";
    } else {
      context.fillStyle = editorColor;
      context.fillRect(x - offset, y - offset, editorBrushSize, editorBrushSize);
    }
    context.globalAlpha = 1;
  }

  function drawEditorLine(context: CanvasRenderingContext2D, from: { x: number; y: number }, to: { x: number; y: number }) {
    for (const point of traceLinePixels(from, to)) drawEditorBrush(context, point.x, point.y);
  }

  function drawEditorShape(context: CanvasRenderingContext2D, start: { x: number; y: number }, end: { x: number; y: number }) {
    if (editorTool === "line") {
      drawEditorLine(context, start, end);
      return;
    }
    const left = Math.min(start.x, end.x);
    const right = Math.max(start.x, end.x);
    const top = Math.min(start.y, end.y);
    const bottom = Math.max(start.y, end.y);
    drawEditorLine(context, { x: left, y: top }, { x: right, y: top });
    drawEditorLine(context, { x: right, y: top }, { x: right, y: bottom });
    drawEditorLine(context, { x: right, y: bottom }, { x: left, y: bottom });
    drawEditorLine(context, { x: left, y: bottom }, { x: left, y: top });
  }

  function fillEditorArea(startX: number, startY: number) {
    const canvas = editorCanvas.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    const colorChannels = editorColor.match(/[a-f\d]{2}/gi)?.map((part) => parseInt(part, 16)) ?? [0, 0, 0];
    const fillColor: PixelColor = [colorChannels[0], colorChannels[1], colorChannels[2], Math.round(editorOpacity * 2.55)];
    if (floodFillPixels(image.data, canvas.width, canvas.height, startX, startY, fillColor)) context.putImageData(image, 0, 0);
  }

  function handleEditorPointerDown(event: React.PointerEvent<HTMLCanvasElement>) {
    const point = editorCoordinates(event);
    const canvas = editorCanvas.current;
    const context = canvas?.getContext("2d");
    if (!point || !canvas || !context) return;
    if (editorTool === "select") {
      const currentSelection = editorSelection;
      if (currentSelection &&
        point.x >= currentSelection.x && point.x < currentSelection.x + currentSelection.width &&
        point.y >= currentSelection.y && point.y < currentSelection.y + currentSelection.height) {
        startSelectionMove(point, currentSelection);
      } else {
        selectionTransform.current = {
          mode: "create",
          anchor: point,
          origin: { x: point.x, y: point.y, width: 1, height: 1 },
          source: null,
        };
        drawing.current = true;
        canvas.setPointerCapture(event.pointerId);
        setEditorSelection({ x: point.x, y: point.y, width: 1, height: 1 });
      }
      return;
    }
    if (editorTool === "eyedropper") {
      const [red, green, blue] = context.getImageData(point.x, point.y, 1, 1).data;
      setEditorColor(`#${[red, green, blue].map((value) => value.toString(16).padStart(2, "0")).join("")}`);
      setEditorTool("pencil");
      return;
    }
    saveEditorUndoFrame();
    if (editorTool === "fill") {
      fillEditorArea(point.x, point.y);
      return;
    }
    drawing.current = true;
    editorStart.current = point;
    editorEnd.current = point;
    editorLastPixel.current = point;
    canvas.setPointerCapture(event.pointerId);
    if (editorTool === "pencil" || editorTool === "eraser") drawEditorBrush(context, point.x, point.y);
  }

  function handleEditorPointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    const point = editorCoordinates(event);
    const start = editorStart.current;
    const canvas = editorCanvas.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    if (editorTool === "select") {
      const transform = selectionTransform.current;
      if (!transform) return;
      const dragPoint = point ?? {
        x: Math.floor((event.clientX - canvas.getBoundingClientRect().left) * canvas.width / canvas.getBoundingClientRect().width),
        y: Math.floor((event.clientY - canvas.getBoundingClientRect().top) * canvas.height / canvas.getBoundingClientRect().height),
      };
      if (transform.mode === "create") {
        const left = Math.max(0, Math.min(transform.anchor.x, dragPoint.x));
        const top = Math.max(0, Math.min(transform.anchor.y, dragPoint.y));
        const right = Math.min(canvas.width, Math.max(transform.anchor.x, dragPoint.x) + 1);
        const bottom = Math.min(canvas.height, Math.max(transform.anchor.y, dragPoint.y) + 1);
        setEditorSelection({ x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) });
      } else if (transform.mode === "move" && transform.source) {
        const x = Math.max(0, Math.min(canvas.width - transform.origin.width, transform.origin.x + dragPoint.x - transform.anchor.x));
        const y = Math.max(0, Math.min(canvas.height - transform.origin.height, transform.origin.y + dragPoint.y - transform.anchor.y));
        const rect = { ...transform.origin, x, y };
        setEditorSelection(rect);
        drawSelectionPreview(transform.source, rect);
      }
      return;
    }
    if (!point) return;
    if (editorTool === "pencil" || editorTool === "eraser") {
      if (editorLastPixel.current) drawEditorLine(context, editorLastPixel.current, point);
      editorLastPixel.current = point;
    } else if (start) {
      editorEnd.current = point;
      const preview = editorPreviewCanvas.current?.getContext("2d");
      if (!preview || !editorPreviewCanvas.current) return;
      preview.clearRect(0, 0, canvas.width, canvas.height);
      drawEditorShape(preview, start, point);
    }
  }

  function handleEditorPointerUp() {
    if (!drawing.current) return;
    if (editorTool === "select") {
      finishSelectionTransform();
      return;
    }
    const pointCanvas = editorCanvas.current;
    const start = editorStart.current;
    const end = editorEnd.current;
    const previewCanvas = editorPreviewCanvas.current;
    const previewContext = previewCanvas?.getContext("2d");
    const context = pointCanvas?.getContext("2d");
    if (start && end && context && previewCanvas && (editorTool === "line" || editorTool === "rectangle")) {
      drawEditorShape(context, start, end);
    }
    if (previewContext && previewCanvas) {
      previewContext.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
    }
    drawing.current = false;
    editorStart.current = null;
    editorEnd.current = null;
    editorLastPixel.current = null;
  }

  function handleSelectionHandleMove(event: React.PointerEvent<HTMLButtonElement>) {
    updateSelectionResize(event.clientX, event.clientY);
  }

  function clearEditorCanvas() {
    const canvas = editorCanvas.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) {
      notify("텍스처 편집 캔버스를 초기화하지 못했어요.");
      return;
    }
    saveEditorUndoFrame();
    context.clearRect(0, 0, canvas.width, canvas.height);
    editorPreviewCanvas.current?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
  }

  function restoreEditorOriginal() {
    if (!selected || !editorCanvas.current) return;
    const canvas = editorCanvas.current;
    const image = new Image();
    image.onload = () => {
      const context = canvas.getContext("2d");
      if (!context) {
        notify("텍스처 편집 캔버스를 초기화하지 못했어요.");
        return;
      }
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      context.drawImage(image, 0, 0);
      setEditorDimensions({ width: canvas.width, height: canvas.height });
      editorUndoStack.current = [];
      editorRedoStack.current = [];
      setUndoCount(0);
      setRedoCount(0);
      notify("원본 텍스처로 되돌렸어요");
    };
    image.onerror = () => notify("원본 텍스처를 다시 불러오지 못했어요.");
    image.src = selected.url;
  }

  function zoomEditor(direction: -1 | 1) {
    setEditorZoom((current) => Math.min(64, Math.max(1, current + direction * (current < 8 ? 1 : 2))));
  }

  async function saveEditedTexture() {
    const canvas = editorCanvas.current;
    if (!selected || !canvas) return;
    const path = editorPath.trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/^assets\/minecraft\/textures\//i, "");
    if (!path.toLowerCase().endsWith(".png") || path.split("/").includes("..")) {
      notify("저장 경로는 textures 폴더 안의 PNG 파일 경로여야 해요.");
      return;
    }
    try {
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((result) => {
        if (result) resolve(result);
        else reject(new Error("편집한 텍스처를 PNG로 저장하지 못했어요."));
      }, "image/png"));
      const editedAsset = {
        ...makeImportedAsset(path, blob),
        width: canvas.width,
        height: canvas.height,
      };
      const byPath = new Map(imported.map((asset) => [asset.path, asset]));
      byPath.set(path, editedAsset);
      const updated = [...byPath.values()];
      setImported(updated);
      setSelectedId(editedAsset.id);
      setEdited((current) => new Set([...current, editedAsset.id]));
      await saveTextureLibrary(updated);
      setEditorOpen(false);
      notify(`${path} 텍스처를 저장했어요`);
    } catch (error) {
      notify(error instanceof Error ? `텍스처를 저장하지 못했어요: ${error.message}` : "텍스처를 저장하지 못했어요");
    }
  }

  async function createNewDrawing() {
    const canvas = document.createElement("canvas");
    canvas.width = 16;
    canvas.height = 16;
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) {
      notify("새 PNG 캔버스를 만들지 못했어요.");
      return;
    }
    const folder = selected?.path.includes("/")
      ? selected.path.slice(0, selected.path.lastIndexOf("/"))
      : categoryFolder(category === "전체" ? "블록" : category);
    let path = `${folder}/new_texture.png`;
    let suffix = 2;
    while (imported.some((asset) => asset.path === path)) path = `${folder}/new_texture_${suffix++}.png`;
    const asset = { ...makeImportedAsset(path, blob), width: 16, height: 16 };
    const updated = [...imported, asset];
    setImported(updated);
    setEdited((current) => new Set([...current, asset.id]));
    setSelectedId(asset.id);
    setCategory("전체");
    setEditorPath(path);
    setEditorOpen(true);
    try {
      await saveTextureLibrary(updated);
    } catch (error) {
      notify(error instanceof Error ? `새 텍스처를 저장하지 못했어요: ${error.message}` : "새 텍스처를 저장하지 못했어요");
    }
  }

  async function downloadSelectedTexture() {
    if (!selected) return;
    try {
      const url = URL.createObjectURL(await textureBlob(selected));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = selected.path.split("/").pop() ?? "texture.png";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      notify(`${selected.name}.png을 다운로드했어요`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "PNG를 다운로드하지 못했어요");
    }
  }

  function copySelectedToNewPack() {
    if (!selected) return;
    setPack((current) => ({ ...current, name: `${selected.name} 리소스팩` }));
    setEdited(new Set([selected.id]));
    notify("선택한 텍스처를 새 리소스팩으로 복사했어요");
  }

  function recordTextureDimensions(asset: Asset, event: React.SyntheticEvent<HTMLImageElement>) {
    const { naturalWidth, naturalHeight } = event.currentTarget;
    if (asset.width === naturalWidth && asset.height === naturalHeight) return;
    const updated = imported.map((item) => item.path === asset.path
      ? { ...item, width: naturalWidth, height: naturalHeight }
      : item);
    setImported(updated);
    void saveTextureLibrary(updated).catch((error: unknown) => notify(error instanceof Error ? `텍스처 정보를 저장하지 못했어요: ${error.message}` : "텍스처 정보를 저장하지 못했어요"));
  }

  async function textureBlob(asset: Asset) {
    return asset.blob;
  }

  async function exportPack(selectedOnly = false) {
    setLoading(true);
    try {
      const zip = new JSZip();
      const assetsToExport = selectedOnly && selected ? [selected] : packAssets;
      if (assetsToExport.length) {
        for (const asset of assetsToExport) {
          zip.file(`assets/minecraft/textures/${asset.path}`, await textureBlob(asset));
        }
      }
      const version = minecraftVersions.find((item) => item.version === pack.version);
      if (!version) throw new Error(`Minecraft ${pack.version}의 리소스팩 형식을 확인할 수 없어요. 지원되는 버전을 선택해 주세요.`);
      const minimumVersion = minecraftVersions.find((item) => item.version === pack.minVersion);
      if (pack.minVersion && !minimumVersion) throw new Error("최소 지원 버전의 리소스팩 형식을 확인할 수 없어요.");
      if (minimumVersion && compareVersions(minimumVersion.version, version.version) > 0) {
        throw new Error("최소 지원 버전은 선택한 Minecraft 버전보다 높을 수 없어요.");
      }
      const supportedFormats = version && minimumVersion && version.packFormat >= 69
        ? { min_inclusive: minimumVersion.packFormat, max_inclusive: version.packFormat }
        : undefined;
      zip.file("pack.mcmeta", JSON.stringify({
        pack: {
          pack_format: version.packFormat,
          ...(supportedFormats ? { supported_formats: supportedFormats } : {}),
          description: pack.description || pack.name,
        },
      }, null, 2));
      const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
      const filename = `${pack.name.trim().replace(/[\\/:*?"<>|]+/g, "-") || "resource-pack"}.zip`;
      const savedTo = await writePackFile(blob, filename);
      notify(`${selectedOnly ? "선택한 텍스처 팩" : "리소스팩"}을 ${savedTo}에 저장했어요`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "리소스팩을 내보내지 못했어요");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#" aria-label="Prism Resource Studio 홈">
          <span className="brand-mark"><Icon name="cube" size={20} /></span>
          <span className="brand-word">PRISM <i>/ RESOURCE STUDIO</i></span>
        </a>
        <div className="top-actions">
          <span className="workspace-label"><span className="status-dot" /> 로컬 워크스페이스</span>
          <button className="button button-muted top-button" onClick={() => vanillaInput.current?.click()} disabled={loading}><Icon name="cube" /> {loading ? "불러오는 중..." : "기본 텍스처 불러오기"}</button>
          <button className="button button-muted top-button" onClick={() => fileInput.current?.click()} disabled={loading}><Icon name="upload" /> 팩/PNG 추가</button>
          <button className="button button-muted top-button" onClick={saveProject}><Icon name="check" /> 저장</button>
          <button className="button button-primary top-button" onClick={() => void exportPack()} disabled={loading}><Icon name="download" /> {loading ? "준비 중..." : "팩 내보내기"}</button>
          <button className="button button-muted settings-trigger" aria-label="팩 설정 열기" title="팩 설정" onClick={() => setSettingsOpen(true)}><Icon name="settings" size={17} /></button>
        </div>
        <input ref={vanillaInput} className="visually-hidden" type="file" accept=".jar,.zip,application/java-archive,application/zip" onChange={(event) => void importFiles(event.target.files, "vanilla")} />
        <input ref={manualJarInput} className="visually-hidden" type="file" accept=".jar,application/java-archive,application/zip" onChange={(event) => void chooseManualMinecraftJar(event.target.files?.[0])} />
        <input ref={fileInput} className="visually-hidden" type="file" accept=".png,.zip,image/png,application/zip" multiple onChange={(event) => void importFiles(event.target.files, "pack")} />
        <input ref={replaceInput} className="visually-hidden" type="file" accept=".png,image/png" onChange={(event) => replaceSelectedTexture(event.target.files?.[0])} />
      </header>

      <div className="workspace">
        <aside className="sidebar">
          <div className="sidebar-project">
            <div className="eyebrow">PROJECT DETAILS</div>
            <h1>MAKER</h1>
            <p>MINECRAFT JAVA · PACK {pack.version}</p>
            <button className="button button-sidebar" onClick={() => vanillaInput.current?.click()} disabled={loading}><Icon name="cube" /> 기본 텍스처 불러오기 <span className="tiny-live">JAR</span></button>
          </div>
          <div className="sidebar-nav">
            <div className="nav-caption">라이브러리 <span>⌘ 1</span></div>
            <button className="nav-row" onClick={() => { setCategory("전체"); setQuery(""); }}><Icon name="grid" /> 모든 리소스 <span>{allAssets.length}</span></button>
            <div className="nav-caption nav-caption-spaced">카테고리 <span>{categoryOrder.length}</span></div>
            {categoryOrder.map((item) => (
              <button key={item} className={`nav-row ${category === item ? "active" : ""}`} onClick={() => setCategory(item)}>
                <Icon name={categoryIcons[item] ?? "cube"} size={15} /> {item}<span>{allAssets.filter((asset) => asset.category === item).length}</span>
              </button>
            ))}
            <button className="nav-row" onClick={() => fileInput.current?.click()}><Icon name="plus" size={15} /> 리소스팩에서 가져오기 <span>ZIP</span></button>
          </div>
          <div className="sidebar-footer">
            <div className="avatar">P</div>
            <div><strong>로컬 프로젝트</strong><small>내 컴퓨터에 저장됨</small></div>
            <span className="online-indicator" />
          </div>
        </aside>

        <section className="library">
          <div className="library-scroll">
            <div className="crumb"><span>WORKSPACE</span><b>/</b> <span>LIBRARY</span></div>
            <div className="title-row">
              <div><div className="eyebrow title-eyebrow">WORKSPACE / LIBRARY</div><h2>리소스 작업실</h2><p className="subtitle">Minecraft 기본 텍스처를 불러와 같은 경로에 덮어써 보세요.</p></div>
              <button className="button button-primary create-button" onClick={() => vanillaInput.current?.click()} disabled={loading}><Icon name="cube" /> 기본 텍스처 불러오기</button>
            </div>

            <div className="toolbar">
              <label className="searchbox">
                <Icon name="search" size={17} />
                <input ref={searchInput} aria-label="리소스 검색" value={search} onChange={(event) => { setSearch(event.target.value); setQuery(event.target.value); }} placeholder="이름 또는 태그로 검색..." />
                <kbd>⌘ K</kbd>
              </label>
              <span className="result-count">{visibleAssets.length}개 리소스</span>
            </div>
            <div className="chips" aria-label="리소스 카테고리">
              {["전체", ...categoryOrder].map((item) => (
                <button key={item} className={`chip ${category === item ? "chip-active" : ""}`} onClick={() => setCategory(item)}>
                  {category === item && <Icon name="check" size={12} />}{item}
                </button>
              ))}
              <span className="chip-separator" />
              <button className="chip chip-add" onClick={() => fileInput.current?.click()}><Icon name="plus" size={13} /> 팩/PNG 추가</button>
            </div>
            <div className="section-heading">
              <span>리소스</span><div className="section-tools"><span>정렬</span><button aria-label={`${sortMode} 정렬`} className="sort-button" onClick={() => setSortMode((mode) => mode === "최신순" ? "가나다순" : "최신순")}>{sortMode} <Icon name="chevron" size={13} /></button></div>
            </div>
            {visibleAssets.length ? (
              <div className="asset-grid">
                {visibleAssets.map((asset) => (
                  <button key={asset.id} className={`asset-card ${selectedId === asset.id ? "selected" : ""}`} onClick={() => setSelectedId(asset.id)}>
                    <span className="asset-thumb"><PixelSprite asset={asset} size={66} /><span className="asset-hover"><Icon name="spark" size={14} /></span></span>
                    <span className="asset-meta"><strong>{asset.name}</strong><span>{asset.category} <i>·</i> {asset.path}</span></span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="empty-state">
                <Icon name={allAssets.length ? "search" : "cube"} size={26} />
                <strong>{allAssets.length ? "검색 결과가 없어요" : "Minecraft 기본 텍스처를 불러오세요"}</strong>
                <span>{allAssets.length ? "다른 이름이나 카테고리로 찾아보세요." : window.prismDesktop ? "설치된 Minecraft client.jar에서 기본 텍스처를 자동으로 불러옵니다." : "게임 버전의 client.jar에서 원본 PNG를 이 브라우저 안에서 읽어옵니다."}</span>
                {allAssets.length
                  ? <button className="button button-muted" onClick={() => { setSearch(""); setQuery(""); setCategory("전체"); }}>필터 초기화</button>
                  : <button className="button button-primary" onClick={() => vanillaInput.current?.click()} disabled={loading}><Icon name="upload" /> {loading ? "텍스처 불러오는 중..." : "Minecraft .jar 선택하기"}</button>}
                {!allAssets.length && <small className="jar-help">%APPDATA%\.minecraft\versions\버전\버전.jar</small>}
              </div>
            )}
            <div className="library-bottom"><span>PRISM RESOURCE LIBRARY</span><span>{allAssets.length} ASSETS <b>·</b> ORIGINAL PNG PATHS</span></div>
          </div>
        </section>

        <aside className="inspector">
          <div className="inspector-head"><div className="eyebrow">INSPECTOR</div><button className="icon-button mobile-close" aria-label="미리보기 닫기"><Icon name="close" /></button></div>
          <div className="preview-heading"><div><h2>리소스 미리보기</h2><p>{selected ? "선택한 원본 PNG 텍스처" : "기본 텍스처를 먼저 불러오세요"}</p></div>{selected && <button className="icon-button" aria-label="미리보기 새로고침" onClick={() => notify("미리보기를 업데이트했어요")}><Icon name="spark" size={15} /></button>}</div>
          <div className="preview-stage">
            <div className="preview-grid" />
            <div className="preview-tile">{selected ? <PixelSprite asset={selected} size={zoom * 18} onLoad={(event) => recordTextureDimensions(selected, event)} /> : <span className="preview-empty"><Icon name="cube" size={30} /></span>}</div>
            <span className="preview-dim">{selected?.width && selected?.height ? `${selected.width} × ${selected.height}` : "PNG"}</span>
          </div>
          <div className="zoom-row"><span>미리보기 크기</span><div><button aria-label="축소" onClick={() => setZoom((value) => Math.max(2, value - 1))}>−</button><span>{zoom}×</span><button aria-label="확대" onClick={() => setZoom((value) => Math.min(7, value + 1))}>+</button></div></div>

          <div className="inspector-section">
            <div className="section-label">리소스 정보 {selected && <span className="live-tag">선택됨</span>}</div>
            {selected ? <>
              <div className="selected-resource"><div className="selected-icon"><PixelSprite asset={selected} size={34} /></div><div><strong>{selected.koreanName}</strong><small>{selected.name}</small></div><span className="category-badge">{selected.category}</span></div>
              <label className="field-label">리소스팩 경로</label><div className="file-name-field"><strong>assets/minecraft/textures/{selected.path}</strong></div>
              <div className="field-pair">              <div><label className="field-label">크기</label><strong>{selected.width && selected.height ? `${selected.width} × ${selected.height} px` : "원본 PNG"}</strong></div><div><label className="field-label">형식</label><strong>PNG 이미지</strong></div></div>
              <div className="preview-actions">
                <button className="button button-primary" onClick={openTextureEditor}><Icon name="pencil" size={14} /> 기본 텍스처 수정</button>
                <button className="button button-primary" onClick={() => replaceInput.current?.click()}><Icon name="upload" size={14} /> 파일 교체</button>
                <button className="button button-danger" onClick={() => void deleteSelectedTexture()} disabled={!imported.some((asset) => asset.id === selected.id)}><Icon name="trash" size={14} /> 텍스처 삭제</button>
                {!imported.some((asset) => asset.id === selected.id) && <small className="delete-hint">직접 가져오거나 불러온 텍스처만 삭제할 수 있어요.</small>}
                <button className="button button-muted" onClick={copySelectedToNewPack}><Icon name="copy" size={14} /> 새 팩으로 복사</button>
                <button className="button button-muted" onClick={() => void exportPack(true)} disabled={loading}><Icon name="download" size={14} /> 팩에서 내보내기</button>
                <button className="button button-muted" onClick={() => void downloadSelectedTexture()}><Icon name="download" size={14} /> 개별 다운로드</button>
                <button className="button button-create" onClick={() => void createNewDrawing()}><Icon name="plus" size={14} /> 새로 그리기</button>
              </div>
            </> : <>
              <p className="inspector-hint">기본 텍스처를 불러오면 원본 경로와 크기가 여기에 표시됩니다.</p>
              <button className="button button-create empty-draw-button" onClick={() => void createNewDrawing()}><Icon name="plus" size={14} /> 새로 그리기</button>
            </>}
          </div>

          <div className="inspector-bottom"><span className="status-dot" /> {editedCount}개 리소스가 팩에 준비됨</div>
        </aside>
      </div>
      {settingsOpen && (
        <div className="modal-backdrop" role="presentation" onClick={(event) => { if (event.target === event.currentTarget && saveProject()) setSettingsOpen(false); }}>
          <section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
            <div className="editor-header">
              <div><span className="eyebrow">PROJECT SETTINGS</span><h2 id="settings-title">팩 설정</h2></div>
              <button className="icon-button" aria-label="설정 닫기" onClick={() => { if (saveProject()) setSettingsOpen(false); }}><Icon name="close" /></button>
            </div>
            <label className="field-label" htmlFor="pack-name">팩 이름</label>
            <input id="pack-name" className="settings-input" value={pack.name} onChange={(event) => updatePack("name", event.target.value)} />
            <label className="field-label" htmlFor="pack-description">팩 설명</label>
            <input id="pack-description" className="settings-input" value={pack.description} onChange={(event) => updatePack("description", event.target.value)} />

            <label className="field-label" htmlFor="pack-version">Minecraft 버전</label>
            <div className="select-wrap">
              <select id="pack-version" className="settings-input" value={pack.version} onChange={(event) => choosePackVersion(event.target.value)}>
                {installedVersions.some((item) => !minecraftVersions.some((known) => known.version === item.version)) && (
                  <optgroup label="설치된 Minecraft 버전">
                    {installedVersions.filter((item) => !minecraftVersions.some((known) => known.version === item.version)).map(({ version }) => <option key={version} value={version}>Minecraft {version}</option>)}
                  </optgroup>
                )}
                {versionGroups.map((group) => <optgroup key={group.label} label={group.label}>{group.versions.map(({ version }) => <option key={version} value={version}>Minecraft {version}</option>)}</optgroup>)}
              </select>
              <Icon name="chevron" size={14} />
            </div>
            <label className="field-label" htmlFor="pack-min-version">이 버전부터 하위 버전까지 지원</label>
            <div className="select-wrap">
              <select id="pack-min-version" className="settings-input" value={pack.minVersion ?? "1.6.1"} onChange={(event) => updatePack("minVersion", event.target.value)}>
                {minecraftVersions.filter((item) => compareVersions(item.version, pack.version) <= 0).map(({ version }) => <option key={version} value={version}>Minecraft {version}부터</option>)}
              </select>
              <Icon name="chevron" size={14} />
            </div>
            <div className="settings-help">
              {selectedVersionInfo && selectedVersionInfo.packFormat >= 69
                ? `선택한 버전부터 ${pack.version}까지의 리소스팩 형식 범위를 지정합니다.`
                : "이 버전의 pack.mcmeta는 하위 버전 호환 범위를 기록하지 않아 선택한 리소스팩 형식만 사용합니다."}
            </div>
            <div className="settings-format">
                <span>팩 형식</span><strong>{selectedVersionInfo?.packFormat ?? "확인할 수 없음"}</strong>
            </div>

            <div className="settings-divider" />
            <div className="settings-subheading">Minecraft 파일 위치</div>
            <div className="folder-select-row">
              <div className="folder-summary">
                <Icon name="folder" size={17} />
                <div><strong>{minecraftFolderName || "Minecraft 폴더를 선택해 주세요"}</strong><small>{installedVersions.length ? `${installedVersions.length}개 버전 자동 검색됨` : "앱 시작 시 설치된 버전을 자동으로 찾습니다"}</small></div>
              </div>
              <button className="button button-muted folder-button" onClick={() => void chooseMinecraftFolder()}><Icon name="search" size={14} /> 찾아보기</button>
            </div>
            <button className="text-button manual-jar-button" onClick={() => manualJarInput.current?.click()}>또는 Minecraft .jar 파일 직접 선택</button>

            <div className="settings-divider" />
            <div className="settings-subheading">리소스팩 저장 위치</div>
            <div className={`destination-option ${!outputFolder ? "destination-selected" : ""}`}>
              <input id="downloads-location" type="radio" name="output-folder" checked={!outputFolder} onChange={() => void useDownloadsFolder()} />
              <label htmlFor="downloads-location"><strong>다운로드</strong><small>{window.prismDesktop ? "앱 기본 다운로드 폴더" : "브라우저 기본 다운로드 폴더"}</small></label>
            </div>
            <div className={`destination-option ${outputFolder ? "destination-selected" : ""}`}>
              <input id="custom-location" type="radio" name="output-folder" checked={Boolean(outputFolder)} onChange={() => void chooseOutputFolder()} />
              <label htmlFor="custom-location"><strong>{outputFolderName || "폴더 선택"}</strong><small>{outputFolder ? "선택한 위치에 바로 저장" : "원하는 폴더를 선택해 저장"}</small></label>
              {outputFolder && <button className="text-button" onClick={(event) => { event.preventDefault(); void chooseOutputFolder(); }}>변경</button>}
            </div>

            <div className="editor-footer">
              <button className="button button-muted" onClick={() => { if (saveProject()) setSettingsOpen(false); }}>닫기</button>
              <button className="button button-primary" onClick={() => { if (saveProject()) setSettingsOpen(false); }}><Icon name="check" size={14} /> 설정 저장</button>
            </div>
          </section>
        </div>
      )}
      {editorOpen && selected && (
        <div className="modal-backdrop editor-backdrop" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) setEditorOpen(false); }}>
          <section className="texture-editor texture-editor-workspace" role="dialog" aria-modal="true" aria-labelledby="editor-title">
            <header className="editor-topbar">
              <div className="editor-brand">
                <span className="eyebrow">PIXEL TEXTURE EDITOR</span>
                <h2 id="editor-title">{selected.name}</h2>
                <small>assets/minecraft/textures/{editorPath}</small>
              </div>
              <div className="editor-top-actions">
                <button className="button button-muted" onClick={restoreEditorOriginal}>원본으로 복원</button>
                <button className="button button-muted" onClick={() => { saveProject(); }}>팩 저장</button>
                <button className="button button-muted" onClick={() => setEditorOpen(false)}>닫기</button>
                <button className="button button-primary" onClick={() => void saveEditedTexture()}><Icon name="check" size={14} /> 적용 및 저장</button>
              </div>
            </header>
            <div className="editor-workspace">
              <aside className="editor-tool-panel">
                <button className="button button-muted editor-open-image" onClick={() => replaceInput.current?.click()}><Icon name="upload" size={14} /> 이미지 불러오기</button>
                <div className="editor-panel-caption">도구</div>
                <div className="editor-tool-list">
                  {([
                    ["select", "사각형 선택", "M"],
                    ["pencil", "연필", "B"],
                    ["eraser", "지우개", "E"],
                    ["fill", "채우기", "G"],
                    ["eyedropper", "색 추출", "I"],
                    ["line", "직선", "L"],
                    ["rectangle", "사각형", "U"],
                  ] as const).map(([tool, label, shortcut]) => (
                    <button key={tool} className={`editor-tool ${editorTool === tool ? "editor-tool-active" : ""}`} aria-pressed={editorTool === tool} title={`${label} (${shortcut})`} onClick={() => setEditorTool(tool)}>
                      <Icon name={tool === "fill" ? "bucket" : tool} size={15} /><span>{label}</span><kbd>{shortcut}</kbd>
                    </button>
                  ))}
                </div>
                {editorSelection && (
                  <div className="editor-selection-actions">
                    <div className="editor-panel-caption">선택 영역 · {editorSelection.width} × {editorSelection.height}</div>
                    <button className="editor-selection-action" onClick={() => copyEditorSelection()}><Icon name="copy" size={13} /> 복사</button>
                    <button className="editor-selection-action" onClick={() => copyEditorSelection(true)}><Icon name="scissors" size={13} /> 잘라내기</button>
                    <button className="editor-selection-action" onClick={deleteEditorSelection}><Icon name="trash" size={13} /> 선택 삭제</button>
                    <button className="editor-selection-action" disabled={!editorClipboard} onClick={pasteEditorSelection}><Icon name="paste" size={13} /> 붙여넣기</button>
                    <button className="editor-selection-action" onClick={() => setEditorSelection(null)}>선택 해제</button>
                  </div>
                )}
                <div className="editor-panel-caption editor-panel-spaced">브러시</div>
                <label className="editor-control-label" htmlFor="brush-size">크기 <span>{editorBrushSize} px</span></label>
                <input id="brush-size" className="editor-range" type="range" min="1" max="8" step="1" value={editorBrushSize} onChange={(event) => setEditorBrushSize(Number(event.target.value))} />
                <label className="editor-control-label editor-range-label" htmlFor="brush-opacity">불투명도 <span>{editorOpacity}%</span></label>
                <input id="brush-opacity" className="editor-range" type="range" min="10" max="100" step="10" value={editorOpacity} onChange={(event) => setEditorOpacity(Number(event.target.value))} />
                <div className="editor-panel-caption editor-panel-spaced">색상</div>
                <label className="editor-color-picker"><input aria-label="그리기 색상" type="color" value={editorColor} onChange={(event) => setEditorColor(event.target.value)} /><span>{editorColor.toUpperCase()}</span></label>
                <div className="editor-palette" aria-label="기본 색상 팔레트">
                  {editorPalette.map((color) => <button key={color} className={`palette-swatch ${editorColor.toLowerCase() === color ? "palette-swatch-selected" : ""}`} style={{ backgroundColor: color }} aria-label={`${color} 색상 선택`} aria-pressed={editorColor.toLowerCase() === color} onClick={() => setEditorColor(color)} />)}
                </div>
                <button className="button button-muted editor-clear-button" onClick={clearEditorCanvas}><Icon name="trash" size={14} /> 캔버스 지우기</button>
              </aside>
              <div className="editor-center">
                <div className="editor-toolbar">
                  <div className="editor-toolbar-group">
                    <button className="icon-button" aria-label="실행 취소" title="실행 취소 (Ctrl+Z)" disabled={!undoCount} onClick={undoEditorAction}><Icon name="undo" size={15} /></button>
                    <button className="icon-button" aria-label="다시 실행" title="다시 실행 (Ctrl+Y)" disabled={!redoCount} onClick={redoEditorAction}><Icon name="redo" size={15} /></button>
                  </div>
                  <div className="editor-toolbar-group editor-zoom-controls">
                    <button className="icon-button" aria-label="축소" onClick={() => zoomEditor(-1)}><Icon name="zoomOut" size={15} /></button>
                    <span>{Math.round(editorZoom * 100)}%</span>
                    <button className="icon-button" aria-label="확대" onClick={() => zoomEditor(1)}><Icon name="zoomIn" size={15} /></button>
                  </div>
                  <button className={`editor-grid-toggle ${editorGrid ? "editor-grid-active" : ""}`} aria-pressed={editorGrid} onClick={() => setEditorGrid((current) => !current)}><Icon name="checker" size={14} /> 픽셀 격자</button>
                </div>
                <div className="editor-canvas-viewport">
                  <div className={`editor-canvas-stack ${!editorDimensions.width ? "editor-canvas-loading" : ""} ${editorGrid && editorZoom >= 6 ? "editor-pixel-grid" : ""}`} style={{ width: Math.max(1, editorDimensions.width * editorZoom), height: Math.max(1, editorDimensions.height * editorZoom), "--editor-zoom": `${editorZoom}px` } as React.CSSProperties}>
                    <canvas ref={editorCanvas} aria-label="픽셀 텍스처 편집 캔버스" onPointerDown={handleEditorPointerDown} onPointerMove={handleEditorPointerMove} onPointerUp={handleEditorPointerUp} onPointerCancel={handleEditorPointerUp} />
                    <canvas ref={editorPreviewCanvas} className="editor-shape-preview" aria-hidden="true" />
                    {editorSelection && (
                      <div className="editor-selection-frame" style={{ left: editorSelection.x * editorZoom, top: editorSelection.y * editorZoom, width: editorSelection.width * editorZoom, height: editorSelection.height * editorZoom }}>
                        {["nw", "n", "ne", "e", "se", "s", "sw", "w"].map((handle) => (
                          <button key={handle} className={`selection-handle selection-handle-${handle}`} aria-label={`선택 영역 크기 조절 ${handle}`} onPointerDown={(event) => handleSelectionResizeStart(event, handle)} onPointerMove={handleSelectionHandleMove} onPointerUp={finishSelectionTransform} onPointerCancel={finishSelectionTransform} />
                        ))}
                      </div>
                    )}
                  </div>
                  {!editorDimensions.width && <div className="editor-loading">텍스처 불러오는 중...</div>}
                </div>
                <footer className="editor-statusbar">
                  <span>{editorDimensions.width || selected.width || "—"} × {editorDimensions.height || selected.height || "—"} px</span>
                  <span>{editorTool === "select" ? "사각형 선택" : editorTool === "pencil" ? "연필" : editorTool === "eraser" ? "지우개" : editorTool === "fill" ? "색 채우기" : editorTool === "eyedropper" ? "색 추출" : editorTool === "line" ? "직선" : "사각형"}</span>
                  <span>{Math.round(editorZoom * 100)}%</span>
                </footer>
              </div>
              <aside className="editor-reference-panel">
                <div className="editor-panel-caption">미리보기</div>
                <div className="editor-reference-preview"><PixelSprite asset={selected} size={96} /></div>
                <strong className="editor-reference-name">{selected.koreanName}</strong>
                <span className="editor-reference-category">{selected.category} · {selected.width ?? "?"} × {selected.height ?? "?"} px</span>
                <div className="editor-reference-tip"><Icon name="info" size={14} /> 투명 배경은 체크무늬로 표시됩니다. Ctrl+Z로 실행 취소, Ctrl+Y로 다시 실행할 수 있어요.</div>
              </aside>
            </div>
            <footer className="editor-bottom-bar">
              <label className="editor-path"><span>textures/</span><input aria-label="텍스처 저장 경로" value={editorPath} onChange={(event) => setEditorPath(event.target.value)} /></label>
              <span>{undoCount ? `${undoCount}개 작업 기록` : "변경 사항 없음"}</span>
              <button className="text-button" onClick={() => setEditorOpen(false)}>취소</button>
              <button className="button button-primary" onClick={() => void saveEditedTexture()}><Icon name="check" size={14} /> 적용 및 저장</button>
            </footer>
          </section>
        </div>
      )}
      {toast && <div className="toast"><Icon name="check" size={16} />{toast}</div>}
    </main>
  );
}

export default App;
