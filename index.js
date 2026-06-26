import { promises as fs, existsSync } from "node:fs";
import path from "node:path";

/**
 * Современный SVG Sprite Generator для Vite 8+ (Без внешних зависимостей).
 * * @param {Object} options - Конфигурация плагина.
 * @param {string} [options.input="src/icons"] - Путь к папке с исходными SVG.
 * @param {string} [options.output="dist/assets"] - Путь для сохранения сгенерированных спрайтов.
 * @param {string} [options.name="sprite.svg"] - Базовое имя файла спрайта.
 * @param {"single"|"folders"} [options.mode="single"] - Режим сборки: один файл или разбиение по папкам.
 * @param {boolean} [options.clean=true] - Очищать ли старые спрайты перед генерацией.
 * @param {boolean} [options.inheritSvgAttrs=true] - Переносить ли атрибуты тега <svg> в <symbol>.
 */
export default function vitePluginSvgSpriteGenerator(options = {}) {
  // Настройки по умолчанию
  const config = {
    input: options.input || "src/icons",
    output: options.output || "dist/assets",
    name: options.name !== undefined ? options.name : "sprite.svg",
    mode: options.mode || "single",
    clean: options.clean ?? true,
    inheritSvgAttrs: options.inheritSvgAttrs ?? true,
  };

  // Нормализация имени (удаление .svg, если пользователь его указал)
  const baseSpriteName = getBaseName(config.name);

  // Логгер Vite (инициализируется в configResolved)
  let viteLogger = null;

  return {
    name: "vite-plugin-svg-sprite-generator",

    // Получаем доступ к логгеру Vite для вывода предупреждений и сообщений
    configResolved(resolvedConfig) {
      viteLogger = resolvedConfig.logger;
    },

    // Запуск генерации при старте сборки или dev-сервера
    async buildStart() {
      await generateSprites({
        config,
        baseSpriteName,
        logger: viteLogger,
      });
    },

    // Настройка watcher для dev-режима
    configureServer(server) {
      const absoluteInput = path.resolve(server.config.root, config.input);
      const absoluteOutput = path.resolve(server.config.root, config.output);

      const handleFileChange = async (filePath) => {
        const absoluteFilePath = path.resolve(filePath);

        // Следим только за файлами внутри input
        if (!absoluteFilePath.startsWith(absoluteInput)) return;

        // Предотвращаем бесконечный цикл, если output находится внутри input
        if (absoluteFilePath.startsWith(absoluteOutput)) return;

        // Нас интересуют только изменения SVG-файлов
        if (!absoluteFilePath.endsWith(".svg")) return;

        await generateSprites({
          config,
          baseSpriteName,
          logger: viteLogger,
        });
      };

      // Подписываемся на события файловой системы
      server.watcher.on("add", handleFileChange);
      server.watcher.on("change", handleFileChange);
      server.watcher.on("unlink", handleFileChange);
    },
  };
}

/**
 * Удаляет расширение .svg из имени файла, если оно присутствует.
 * * @param {string} name
 * @returns {string}
 */
function getBaseName(name) {
  if (!name) return "";
  return name.endsWith(".svg") ? name.slice(0, -4) : name;
}

/**
 * Возвращает имя файла спрайта на основе базового имени и имени папки.
 * * @param {string} baseSpriteName
 * @param {string} folderName
 * @returns {string}
 */
function getSpriteFileName(baseSpriteName, folderName) {
  if (baseSpriteName !== "") {
    return folderName
      ? `${baseSpriteName}-${folderName}.svg`
      : `${baseSpriteName}.svg`;
  }
  return folderName ? `${folderName}.svg` : "sprite.svg";
}

/**
 * Рекурсивно ищет все файлы SVG в указанной директории с помощью нативного Node.js API.
 * * @param {string} inputDir
 * @returns {Promise<string[]>} Список абсолютных путей к файлам.
 */
async function getSvgFiles(inputDir) {
  try {
    // Нативный рекурсивный обход директории (доступен в Node.js >= 18.5)
    const files = await fs.readdir(inputDir, { recursive: true });

    return files
      .filter((file) => file.endsWith(".svg"))
      .map((file) => path.resolve(inputDir, file));
  } catch {
    return [];
  }
}

/**
 * Извлекает содержимое и сырую строку атрибутов тега <svg> без разбора регулярными выражениями всего файла.
 * * @param {string} svgRaw
 * @returns {{attrsRaw: string, innerContent: string}|null}
 */
function parseSvgContent(svgRaw) {
  const svgOpenMatch = svgRaw.match(/<svg([^>]*?)>/i);
  if (!svgOpenMatch) return null;

  const attrsRaw = svgOpenMatch[1];
  const closingSvgIndex = svgRaw.lastIndexOf("</svg>");
  if (closingSvgIndex === -1) return null;

  const openingTagLength = svgOpenMatch[0].length;
  const openingTagIndex = svgOpenMatch.index;

  // Извлекаем только то, что находится внутри <svg>...</svg>
  const innerContent = svgRaw
    .substring(openingTagIndex + openingTagLength, closingSvgIndex)
    .trim();

  return { attrsRaw, innerContent };
}

/**
 * Парсит сырую строку атрибутов и формирует объект для тега <symbol>.
 * * @param {string} attrsRaw
 * @param {boolean} inheritSvgAttrs
 * @param {boolean} forceInherit
 * @returns {Object}
 */
function extractSvgAttributes(attrsRaw, inheritSvgAttrs, forceInherit) {
  const attrs = {};

  // Если наследование отключено глобально и не форсировано локально через "!",
  // мы обязаны сохранить ТОЛЬКО viewBox (при наличии)
  if (!inheritSvgAttrs && !forceInherit) {
    const viewBoxMatch = attrsRaw.match(/viewBox=["']([^"']+)["']/i);
    if (viewBoxMatch) {
      attrs["viewBox"] = viewBoxMatch[1];
    }
    return attrs;
  }

  // Регулярное выражение исключительно для безопасного перебора атрибутов из открывающего тега
  const attrRegex = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  let match;

  while ((match = attrRegex.exec(attrsRaw)) !== null) {
    const key = match[1];
    const value = match[2] || match[3] || match[4];
    const lowerKey = key.toLowerCase();

    // Исключаем xmlns и id согласно спецификации
    if (lowerKey !== "xmlns" && lowerKey !== "id") {
      attrs[key] = value;
    }
  }

  return attrs;
}

/**
 * Создает строковое представление тега <symbol> из исходного SVG файла.
 * * @param {string} filePath
 * @param {string} svgRaw
 * @param {boolean} inheritSvgAttrs
 * @returns {string|null}
 */
function createSymbol(filePath, svgRaw, inheritSvgAttrs) {
  const parsed = parseSvgContent(svgRaw);
  if (!parsed) return null;

  const fileName = path.basename(filePath, ".svg");
  const forceInherit = fileName.startsWith("!");

  // Очищаем ID от префикса локального переопределения
  const id = forceInherit ? fileName.slice(1) : fileName;

  const attrs = extractSvgAttributes(
    parsed.attrsRaw,
    inheritSvgAttrs,
    forceInherit,
  );

  const attrString = Object.entries(attrs)
    .map(([k, v]) => `${k}="${v}"`)
    .join(" ");

  const spacedAttrString = attrString ? ` ${attrString}` : "";

  return `<symbol id="${id}"${spacedAttrString}>${parsed.innerContent}</symbol>`;
}

/**
 * Выполняет удаление старых сгенерированных спрайтов нативными средствами.
 * * @param {Object} params
 * @param {string} params.outputDir
 * @param {string} params.baseSpriteName
 * @param {string} params.mode
 * @param {string[]} params.targetFiles
 */
async function cleanOutput({ outputDir, baseSpriteName, mode, targetFiles }) {
  if (!existsSync(outputDir)) return;

  if (mode === "single") {
    const spritePath = path.join(outputDir, `${baseSpriteName}.svg`);
    if (existsSync(spritePath)) {
      await fs.unlink(spritePath);
    }
  } else if (mode === "folders") {
    if (baseSpriteName !== "") {
      // Находим и удаляем старые файлы, подходящие под маску `name-*.svg`
      const files = await fs.readdir(outputDir);
      const prefix = `${baseSpriteName}-`;

      const filesToDelete = files
        .filter((file) => file.startsWith(prefix) && file.endsWith(".svg"))
        .map((file) => path.join(outputDir, file));

      for (const file of filesToDelete) {
        if (existsSync(file)) await fs.unlink(file);
      }
    } else {
      // Если name === "", удаляем исключительно файлы текущей сборки (защита пользовательских файлов)
      for (const file of targetFiles) {
        if (existsSync(file)) await fs.unlink(file);
      }
    }
  }
}

/**
 * Логирует результат успешного создания спрайта в консоль.
 * * @param {Object} logger - Логгер Vite.
 * @param {string} fileName
 * @param {number} iconCount
 */
function logSuccess(logger, fileName, iconCount) {
  const message = `\n[vite-plugin-svg-sprite-generator]\n\nСоздан:\n\n${fileName}\n\n(${iconCount} icons)\n`;
  if (logger) {
    logger.info(message, { timestamp: true });
  } else {
    console.log(message);
  }
}

/**
 * Логирует предупреждения, не прерывая процесс сборки.
 * * @param {Object} logger - Логгер Vite.
 * @param {string} text
 */
function logWarning(logger, text) {
  const message = `[vite-plugin-svg-sprite-generator] Precaution: ${text}`;
  if (logger) {
    logger.warn(message, { timestamp: true });
  } else {
    console.warn(message);
  }
}

/**
 * Генерирует один общий спрайт из всех переданных SVG.
 */
async function generateSingleSprite({
  validSvgFiles,
  outputDir,
  baseSpriteName,
  config,
  logger,
}) {
  const symbols = [];

  for (const file of validSvgFiles) {
    const content = await fs.readFile(file, "utf-8");
    const symbol = createSymbol(file, content, config.inheritSvgAttrs);
    if (symbol) symbols.push(symbol);
  }

  if (symbols.length === 0) return;

  await fs.mkdir(outputDir, { recursive: true });

  if (config.clean) {
    await cleanOutput({ outputDir, baseSpriteName, mode: "single" });
  }

  const spriteFileName = `${baseSpriteName}.svg`;
  const spritePath = path.join(outputDir, spriteFileName);
  const spriteContent = `<svg xmlns="http://www.w3.org/2000/svg">\n${symbols.join("\n")}\n</svg>`;

  await fs.writeFile(spritePath, spriteContent, "utf-8");
  logSuccess(logger, spriteFileName, symbols.length);
}

/**
 * Генерирует отдельные спрайты на основе структуры подпапок.
 */
async function generateFolderSprites({
  validSvgFiles,
  inputDir,
  outputDir,
  baseSpriteName,
  config,
  logger,
}) {
  const groups = {};

  // Распределяем файлы по группам (используя только первую папку относительно input)
  for (const file of validSvgFiles) {
    const relativePath = path.relative(inputDir, file);
    const parts = relativePath.split(path.sep);
    const folder = parts.length > 1 ? parts[0] : "";

    if (!groups[folder]) {
      groups[folder] = [];
    }
    groups[folder].push(file);
  }

  // Формируем карту будущих файлов спрайтов
  const targets = Object.entries(groups).map(([folder, files]) => {
    const spriteFileName = getSpriteFileName(baseSpriteName, folder);
    const spritePath = path.join(outputDir, spriteFileName);
    return { folder, files, spriteFileName, spritePath };
  });

  await fs.mkdir(outputDir, { recursive: true });

  if (config.clean) {
    const targetFilesPaths = targets.map((t) => t.spritePath);
    await cleanOutput({
      outputDir,
      baseSpriteName,
      mode: "folders",
      targetFiles: targetFilesPaths,
    });
  }

  // Создаем каждый спрайт отдельно
  for (const target of targets) {
    const symbols = [];

    for (const file of target.files) {
      const content = await fs.readFile(file, "utf-8");
      const symbol = createSymbol(file, content, config.inheritSvgAttrs);
      if (symbol) symbols.push(symbol);
    }

    if (symbols.length === 0) continue;

    const spriteContent = `<svg xmlns="http://www.w3.org/2000/svg">\n${symbols.join("\n")}\n</svg>`;
    await fs.writeFile(target.spritePath, spriteContent, "utf-8");
    logSuccess(logger, target.spriteFileName, symbols.length);
  }
}

/**
 * Главный оркестратор процесса валидации и сборки спрайтов.
 */
async function generateSprites({ config, baseSpriteName, logger }) {
  const inputDir = path.resolve(config.input);
  const outputDir = path.resolve(config.output);

  if (!existsSync(inputDir)) {
    logWarning(logger, `Входная директория "${config.input}" не существует.`);
    return;
  }

  const svgFiles = await getSvgFiles(inputDir);
  if (svgFiles.length === 0) {
    logWarning(logger, `SVG-файлы в директории "${config.input}" не найдены.`);
    return;
  }

  // Отсекаем черновики (_*.svg) и сортируем алфавитно для предсказуемости результатов
  const validSvgFiles = svgFiles
    .filter((file) => !path.basename(file).startsWith("_"))
    .sort((a, b) => a.localeCompare(b));

  if (validSvgFiles.length === 0) {
    logWarning(
      logger,
      `Все найденные SVG файлы являются скрытыми (начинаются с "_").`,
    );
    return;
  }

  if (config.mode === "single") {
    await generateSingleSprite({
      validSvgFiles,
      outputDir,
      baseSpriteName,
      config,
      logger,
    });
  } else if (config.mode === "folders") {
    await generateFolderSprites({
      validSvgFiles,
      inputDir,
      outputDir,
      baseSpriteName,
      config,
      logger,
    });
  }
}
