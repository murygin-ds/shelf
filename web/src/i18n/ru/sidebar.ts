import type { Messages } from '../shape';

export const sidebar = {
  quickFind: 'Быстрый поиск',

  notes: 'Заметки',
  search: 'Поиск',
  graph: 'Граф',
  trash: 'Корзина',

  vault: 'Хранилище',
  tags: 'Теги',
  soloKey: 'Свой ключ',

  emptyReadOnly:
    'Здесь пока пусто, а режим только для чтения включён — выключите его в меню профиля, чтобы что-то добавить.',
  empty:
    'Здесь пока пусто. Добавьте папку или заметку — и то и другое шифруется до того, как покинет это устройство.',

  newFolder: 'Новая папка',
  newNote: 'Новая заметка',
  newHere: 'Создать здесь',
  newFolderHere: 'Новая папка здесь',
  newNoteHere: 'Новая заметка здесь',
  collapse: 'Свернуть',
  expand: 'Развернуть',
  permissions: 'Права доступа',
  changeIcon: 'Сменить значок',
  moveToTrash: 'Переместить в корзину',

  namePrompt: 'Имя',
  noteTitlePrompt: 'Заголовок заметки',
  noteTitleInitial: 'Без названия',
  folderNamePrompt: 'Имя папки',
  folderNameInitial: 'Новая папка',

  iconLabel: 'Значок',
  iconReset: 'Сбросить',
} satisfies Messages['sidebar'];
