import { counted } from '../plural';
import type { Messages } from '../shape';

export const shell = {
  vaultNamePrompt: 'Имя хранилища',
  vaultNameInitial: 'Личное',
  firstVaultLabel: 'Назовите первое хранилище',
  firstVaultHint:
    'Всё, что вы пишете, лежит в хранилище. Его ключ создаётся на этом устройстве и запечатывается на ваш открытый ключ, поэтому наружу не уходит ничего читаемого.',
  firstVaultConfirm: 'Создать хранилище',

  unsaved: 'Не сохранено',
  savedNotSent: 'Сохранено здесь · не отправлено',
  savedEncrypted: 'Сохранено · зашифровано',

  readOnly: 'Только чтение',
  readOnlyTip:
    'Ничто на этом устройстве не пишет ни в одно хранилище. Нажмите, чтобы выключить режим.',

  emptyNote: 'Ничего не открыто',
  emptyVault: 'Хранилищ пока нет',
  emptyNoteLede:
    'Выберите заметку в боковой панели или создайте новую. Заголовки и тексты шифруются здесь, до того как что-то уйдёт на сервер.',
  emptyNoteLedeReadOnly:
    'Выберите заметку в боковой панели. Включён режим только для чтения, поэтому с этого устройства здесь ничего не изменить.',
  emptyVaultLede:
    'Начните с хранилища. Его ключ создаётся на этом устройстве и запечатывается на ваш открытый ключ.',
  emptyVaultLedeReadOnly:
    'Читать пока нечего, а режим только для чтения включён — выключите его, чтобы создать первое хранилище.',
  newVault: 'Новое хранилище',

  noVault: 'Нет хранилища',
  tree: (notes: number, folders: number) =>
    `${counted(notes, ['заметка', 'заметки', 'заметок'])} · ${counted(folders, ['папка', 'папки', 'папок'])}`,
  index: (covered: number, total: number) => `Индекс ${covered}/${total}`,
  counts: (words: number, chars: number) =>
    `${counted(words, ['слово', 'слова', 'слов'])} · ${counted(chars, ['знак', 'знака', 'знаков'])}`,

  menu: {
    cut: 'Вырезать',
    paste: 'Вставить',
    selectAll: 'Выделить всё',
    newNote: 'Новая заметка',
    newFolder: 'Новая папка',
    search: 'Поиск',
    graph: 'Граф',
    trash: 'Корзина',
    noteTitlePrompt: 'Заголовок заметки',
    noteTitleInitial: 'Без названия',
    folderNamePrompt: 'Имя папки',
    folderNameInitial: 'Новая папка',
  },

  account: {
    profile: 'Профиль',
    readOnlyMode: 'Только чтение',
    readOnlyOn: 'Вкл',
    lockKeys: 'Заблокировать ключи',
    signOut: 'Выйти',
    keyUnlocked: 'Ключ открыт',
    keyLocked: 'Ключ заблокирован',
  },

  palette: {
    placeholder: 'Найти заметку',
    notes: 'Заметки',
    actions: 'Действия',
    nothing: 'Ни одной заметки не нашлось.',
    everything: (term: string) => `Искать везде «${term}»`,
    navigate: '↑↓ Выбрать',
    openHint: '↵ Открыть',
    local: 'Поиск идёт на устройстве',
  },
} satisfies Messages['shell'];
