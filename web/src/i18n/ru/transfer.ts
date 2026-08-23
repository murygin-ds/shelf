import { counted, plural, type Forms } from '../plural';
import type { Messages } from '../shape';

/** «1 папка и 2 заметки» — в том падеже, которым управляет причина. */
function pair(folders: number, notes: number, forFolder: Forms, forNote: Forms): string {
  return [
    ...(folders > 0 ? [counted(folders, forFolder)] : []),
    ...(notes > 0 ? [counted(notes, forNote)] : []),
  ].join(' и ');
}

const nominative = (folders: number, notes: number): string =>
  pair(folders, notes, ['папка', 'папки', 'папок'], ['заметка', 'заметки', 'заметок']);

const genitive = (folders: number, notes: number): string =>
  pair(folders, notes, ['папки', 'папок', 'папок'], ['заметки', 'заметок', 'заметок']);

const accusative = (folders: number, notes: number): string =>
  pair(folders, notes, ['папку', 'папки', 'папок'], ['заметку', 'заметки', 'заметок']);

/** Два вида сразу — это составное подлежащее, а оно берёт множественное при любых числах. */
function agrees(folders: number, notes: number, forms: Forms): string {
  return folders > 0 && notes > 0 ? forms[2] : plural(folders + notes, forms);
}

const NOTES: Forms = ['заметка', 'заметки', 'заметок'];
const FOLDERS: Forms = ['папка', 'папки', 'папок'];
const IN_FOLDERS: Forms = ['папке', 'папках', 'папках'];

export const transfer = {
  untitled: 'Без названия',

  leftOut: (what: string) => `Пропущено: ${what}.`,

  skipped: {
    locked: (folders: number, notes: number) => `для ${genitive(folders, notes)} нет ключа`,
    'no-key': (folders: number, notes: number) =>
      `${accusative(folders, notes)} не удалось открыть`,
    missing: (folders: number, notes: number) => `${genitive(folders, notes)} нет в архиве`,
    'too-large': (folders: number, notes: number) =>
      `${accusative(folders, notes)} не удалось записать — слишком много текста`,
    'too-deep': (folders: number, notes: number) =>
      `${nominative(folders, notes)} ${agrees(folders, notes, ['вложена', 'вложены', 'вложены'])} ` +
      'глубже, чем позволяет Shelf',
    orphaned: (folders: number, notes: number) =>
      `у ${genitive(folders, notes)} в архиве нет родительской папки`,
  },

  exporting: {
    title: 'Экспорт хранилища',
    subtitle: (vault: string, notes: number, folders: number) =>
      `${vault} · ${counted(notes, NOTES)} · ${counted(folders, FOLDERS)}`,
    noVault: 'Хранилище не открыто',

    wrote: (notes: number, folders: number) =>
      `— записано ${counted(notes, NOTES)} и ${counted(folders, FOLDERS)}.`,
    keepItSafe:
      'Файл на диске — открытый текст. Держите его там же, где держали бы сами заметки, или ' +
      'удалите, когда возьмёте из него нужное.',

    warnLead: 'Этот архив не зашифрован.',
    warnBody:
      'Каждая заметка уходит с этого устройства как Markdown, который прочитает любой, у кого ' +
      'есть файл. Защита Shelf заканчивается на скачивании: дальше файл защищает только то, ' +
      'где вы его держите.',

    section: 'Что попадёт внутрь',
    asMarkdown: (notes: number) =>
      `${counted(notes, NOTES)} в Markdown, в тех же папках, что и в боковой панели.`,
    manifest:
      '— файл, в котором имена, значки и теги записаны точно, чтобы архив можно было ' +
      'импортировать обратно.',
    noTrash: 'Из корзины ничего не берётся.',
    noKey: (folders: number, notes: number) =>
      `В архив не попадёт то, для чего нет ключа: ${nominative(folders, notes)}.`,

    reading: (done: number, total: number) => `Читаем тексты ${done}/${total}`,
    footerNote: 'Архив не зашифрован',
    busy: 'Экспортируем…',
    run: 'Экспортировать',
  },

  importing: {
    title: 'Импорт хранилища',
    subtitle: 'Из архива, который записал Shelf',

    filled: (notes: number, folders: number) =>
      `— теперь ${counted(notes, NOTES)} в ${counted(folders, IN_FOLDERS)}.`,
    failed: (folders: number, notes: number, why: string) =>
      `${accusative(folders, notes)} записать не удалось: ${why} Хранилище осталось как есть — ` +
      'если хотите начать заново, удалите его из меню хранилищ.',

    cannotCarry: 'Чего архив не переносит',
    noHistory: 'Историю версий и подписи под ней.',
    noMembers: 'Участников, права доступа и ключи: это хранилище только ваше.',
    noScopes: 'Папки с собственным ключом — здесь всё лежит под ключом хранилища.',

    ledeLead: 'Создаётся новое хранилище.',
    ledeBody: 'Ничего в тех хранилищах, что у вас уже есть, не читается и не меняется.',

    another: 'Выбрать другой архив',
    choose: 'Выбрать архив',
    dropHint: 'или перетащите сюда .zip',

    summary: (notes: number, folders: number) =>
      `${counted(notes, NOTES)} · ${counted(folders, FOLDERS)}`,
    exportedOn: (at: string) => `экспортирован ${at}`,

    nameLabel: 'Имя нового хранилища',
    keepOpen: 'Не закрывайте вкладку',

    footerDone: 'Архив на диске остаётся открытым текстом',
    footerNew: 'Новое хранилище с ключом на этом устройстве',
    busy: 'Импортируем…',
    run: 'Создать хранилище',
  },
} satisfies Messages['transfer'];
