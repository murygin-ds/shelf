import { counted, plural } from '../plural';
import type { Messages } from '../shape';

export const sync = {
  offline: 'Нет связи',
  offlineQueued: (queued: number) => `Нет связи · ${queued} в очереди`,
  sending: (queued: number) => `Отправка ${queued}`,
  saving: 'Сохранение',
  syncing: 'Синхронизация',
  connecting: 'Подключение',
  synced: 'Синхронизировано',

  offlineDetail: (queued: number) =>
    queued > 0
      ? `Нет связи с сервером. ${counted(queued, ['изменение', 'изменения', 'изменений'])} ${plural(queued, ['запечатано', 'запечатаны', 'запечатаны'])} на этом устройстве и ${plural(queued, ['уйдёт', 'уйдут', 'уйдут'])} на сервер, когда связь вернётся.`
      : 'Нет связи с сервером. Всё, что уже есть на этом устройстве, остаётся читаемым, а всё, что вы напишете, лежит здесь, пока связь не вернётся.',

  sendingDetail: (queued: number) =>
    `На сервер ${plural(queued, ['уходит', 'уходят', 'уходит'])} ${counted(queued, ['изменение', 'изменения', 'изменений'])}, ${plural(queued, ['написанное', 'написанные', 'написанных'])}, пока связи не было.`,

  savingDetail: 'Заметка шифруется и уходит на сервер.',
  dirtyDetail:
    'Есть несохранённые правки. Они зашифруются и уйдут через мгновение после того, как вы перестанете печатать.',
  syncingDetail: 'С сервера приходят изменения.',
  connectingDetail: 'Связи с сервером ещё не было.',
  syncedDetail: 'Всё, что есть на этом устройстве, есть и на сервере.',

  lastSynced: (when: string) => `Последняя синхронизация — ${when}.`,
  neverSynced: 'С сервера пока ничего не прочитано.',
} satisfies Messages['sync'];
