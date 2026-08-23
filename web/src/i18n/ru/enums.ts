import type { Messages } from '../shape';

export const enums = {
  role: {
    owner: 'Владелец',
    admin: 'Администратор',
    editor: 'Редактор',
    viewer: 'Читатель',
  },

  permission: {
    own: 'Полный доступ',
    edit: 'Может редактировать',
    comment: 'Может комментировать',
    view: 'Может читать',
    none: 'Нет доступа',
  },

  projectStatus: {
    planning: 'в планах',
    active: 'в работе',
    paused: 'на паузе',
    done: 'готово',
    unset: 'без статуса',
  },

  importPhase: {
    vault: 'Создаём хранилище',
    folders: 'Строим дерево',
    notes: 'Пишем заметки',
    links: 'Связываем',
  },
} satisfies Messages['enums'];
