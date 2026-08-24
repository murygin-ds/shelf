import type { Messages } from '../shape';

export const editor = {
  tab: {
    close: 'Закрыть',
    closeOthers: 'Закрыть остальные',
    closeAll: 'Закрыть все',
  },

  changeIcon: 'Сменить значок',
  body: 'Текст заметки',
  task: 'Задача',

  updated: (when: string) => `Обновлено ${when}`,
  readOnly: 'Только чтение',
  encrypting: 'Шифруем…',
  unsaved: 'Не сохранено',

  access: {
    own: 'Полный доступ',
    edit: 'Редактирование',
    comment: 'Комментирование',
    view: 'Чтение',
    none: 'Нет доступа',
  },

  peer: (name: string, access: string, saving: boolean) =>
    `${name} · ${access}${saving ? ' · сохраняет' : ''}`,

  locked:
    'Эта заметка зашифрована ключом, которого у вас нет. Сервер помочь не может — дать доступ способен только тот, у кого он уже есть.',

  placeholder: {
    empty: 'Эта заметка пуста.',
    write: 'Пишите в Markdown. Всё, что здесь появится, шифруется до того, как покинет это устройство.',
  },

  conflict: {
    lead: 'Пока вы редактировали, эту заметку сохранил кто-то ещё. Сервер держит шифротекст, который не может прочитать, поэтому объединить две версии он не в состоянии — выбирать вам.',
    reload: 'Отбросить мою версию и перезагрузить',
    fork: 'Сохранить мою версию новой заметкой',
    copy: 'Скопировать в буфер обмена',
  },

  grid: {
    size: (rows: number, columns: number) => `${rows} на ${columns}`,
    empty: 'Таблица',
  },

  tableColumn: (index: number) => `Столбец ${index}`,

  menu: {
    row: 'Строка',
    rowAbove: 'Вставить выше',
    rowBelow: 'Вставить ниже',
    rowDelete: 'Удалить строку',

    column: 'Столбец',
    columnLeft: 'Вставить слева',
    columnRight: 'Вставить справа',
    columnDelete: 'Удалить столбец',

    tableDelete: 'Удалить таблицу',

    open: 'Открыть',
    openTab: 'Открыть в новой вкладке',

    heading: 'Заголовок',
    heading1: 'Заголовок 1',
    heading2: 'Заголовок 2',
    heading3: 'Заголовок 3',
    normal: 'Обычный текст',

    list: 'Список',
    bullet: 'Маркированный',
    task: 'Задача',
    quote: 'Цитата',

    table: 'Таблица',
    divider: 'Разделитель',
    codeBlock: 'Блок кода',

    bold: 'Полужирный',
    italic: 'Курсив',
    strike: 'Зачёркнутый',
    code: 'Код',

    case: 'Регистр',
    upper: 'ВЕРХНИЙ РЕГИСТР',
    lower: 'нижний регистр',
    title: 'Как В Заголовке',
    sentence: 'Как в предложении',

    link: 'Ссылка на заметку',

    paste: 'Вставить',
    copy: 'Копировать',
    cut: 'Вырезать',
  },
} satisfies Messages['editor'];
