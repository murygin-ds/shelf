import type { Messages } from '../shape';

export const store = {
  openVaultFirst: 'Сначала откройте хранилище.',
  readOnly: 'В этом браузере включён режим только для чтения.',
  nameRequired: 'Сначала введите имя.',
  nameTaken: (name: string) => `Здесь уже есть «${name}».`,
  areaNameTaken: (area: string, name: string) => `В папке ${area} уже есть «${name}».`,

  bodyNotHere: (name: string) =>
    `Заметка «${name}» на это устройство ещё не попала, а связи, чтобы её получить, нет.`,

  unverifiedEdit: 'Пришла правка, которую не удалось проверить, и она не применена.',

  liveCopyUnavailable: 'Общая копия этой заметки не открылась. Перезагрузите страницу, чтобы попробовать снова.',

  offlineGone: 'Заметку, написанную офлайн, не удалось восстановить: её больше нет.',
  offlineKeyless: 'Заметку, написанную офлайн, не удалось восстановить: её ключа больше нет.',
  offlineKept: (name: string) =>
    `Заметка «${name}» изменилась, пока вы были офлайн; ваша версия сохранена отдельной копией.`,

  changeNotSaved: 'Связи нет. Это изменение не сохранено — повторите его, когда связь вернётся.',

  copyName: {
    mine: (name: string) => `${name} (моя версия)`,
    offline: (name: string) => `${name} (офлайн-копия)`,
  },
} satisfies Messages['store'];
