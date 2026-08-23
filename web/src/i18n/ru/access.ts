import { counted } from '../plural';
import type { Messages } from '../shape';

const SET_HERE = 'задано на этой папке';

export const access = {
  rotateVaultKey: 'Ротировать ключ хранилища',
  reencrypting: (done: number, total: number) => `Перешифровываем ${done}/${total || '…'}`,

  members: {
    title: 'Участники и доступ',
    subtitle: (members: number, invites: number) =>
      `${counted(members, ['участник', 'участника', 'участников'])}` +
      `${invites === 0 ? '' : ` · ${counted(invites, ['приглашение', 'приглашения', 'приглашений'])} в ожидании`}` +
      ' · число мест на своём сервере не ограничено',
    readOnly:
      'Включён режим только для чтения: здесь видно, кто держит ключ, но выдать или отобрать ' +
      'доступ с этого устройства нельзя.',
    inviteHint: 'Приглашение по коду — код вы передаёте сами',
    sealing: 'Запечатываем ключи…',
    createInvite: 'Создать приглашение',
    codeNote:
      'Показан один раз — сервер хранит только его дайджест. Присоединиться сможет любой, у ' +
      'кого есть код, поэтому передайте его по каналу, которому доверяете, а не по тому же, ' +
      'где ходит ссылка.',
    revoked: (keys: number) =>
      'Доступ отозван сразу — это защищает всё, что будет записано дальше. Уже прочитанное ' +
      `так не отменить: для этого осталось ротировать ${counted(keys, ['ключ', 'ключа', 'ключей'])}.`,
    section: 'Участники',
    columns: {
      member: 'Участник',
      role: 'Роль',
      folders: 'Папки',
      key: 'Ключ',
    },
    you: 'Вы',
    allFolders: 'все',
    fingerprintTip: 'Отпечаток ключа — сверьте его по другому каналу',
    removeTip: 'Убрать из хранилища',
    invites: 'Приглашения в ожидании',
    anyoneWithCode: 'Любой, у кого есть код',
    pending: 'Ожидает',
    inviteMeta: (role: string, expires: string) => `${role} · истекает ${expires}`,
    revokeTip: 'Отозвать',
    footerConnected: 'Ключи запечатаны для каждого участника · ключ коннектора хранит этот сервер',
    footerAlone: 'Ключи запечатаны для каждого участника · сервер не хранит ни одного',
  },

  groups: {
    section: (count: number) => `Группы · ${count}`,
    empty:
      'Группа держит доступ от имени нескольких человек. Её ключ запечатан для каждого ' +
      'участника, поэтому добавить кого-то потом — это одна печать, а не по одной на каждую папку.',
    meta: (members: number, keyVersion: number) =>
      `${counted(members, ['участник', 'участника', 'участников'])} · ключ v${keyVersion}`,
    pick: 'Добавить или убрать…',
    disbandTip: 'Распустить',
    create: 'Новая группа',
    namePrompt: 'Название группы',
    nameSample: 'Дизайн',
  },

  permissions: {
    title: (folder: string) => `Права доступа — ${folder}`,
    subtitle: (overrides: number) =>
      `Папка · ${counted(overrides, ['переопределение', 'переопределения', 'переопределений'])} на этом узле`,
    inheritsKey:
      'Папка зашифрована ключом хранилища, поэтому сужение доступа здесь держится только на ' +
      'сервере — у всех, кто уже держит этот ключ, он остаётся. Настоящим запрет делает ' +
      'собственный ключ папки.',
    protect: 'Защитить собственным ключом',
    ownKey: 'У папки есть собственный ключ, поэтому запрет здесь криптографический.',
    whoHasAccess: (count: number) => `Кто имеет доступ · ${count}`,
    memberMeta: (inheritedFrom: string | null) =>
      inheritedFrom === null ? SET_HERE : `унаследовано от роли «${inheritedFrom}»`,
    resetTip: 'Сбросить до унаследованного',
    groupMeta: (granted: boolean, members: number) =>
      `${granted ? SET_HERE : 'доступа здесь нет'} · ` +
      counted(members, ['участник', 'участника', 'участников']),
    alone:
      'В хранилище пока больше никого нет. Сначала пригласите кого-нибудь в разделе ' +
      '«Участники и доступ».',
    footer: 'Расширение доступа запечатывает ключ папки для этого участника',
  },

  security: {
    title: 'Ключи и история',
    subtitle: (vault: string, keyVersion: number) => `${vault} · ключ хранилища v${keyVersion}`,
    noVault: 'Хранилище не выбрано',
    section: 'Ключ хранилища',
    vaultKey: (keyVersion: number, members: number, soloKeys: number) => {
      // «для» takes the genitive, so the count of members is not the same shape as the count
      // of folders two clauses later — one paragraph, two agreements.
      const wrapped =
        `Версия ${keyVersion}, ключ завёрнут для ` +
        `${counted(members, ['участника', 'участников', 'участников'])}.`;

      return soloKeys === 0
        ? `${wrapped} Собственного ключа нет ни у одной папки, поэтому ротация здесь охватывает всё хранилище.`
        : `${wrapped} Собственный ключ есть у ${counted(soloKeys, ['папки', 'папок', 'папок'])}, ` +
            'и ротация здесь такие папки не затрагивает.';
    },
    stale:
      'Кто-то, кто держал этот ключ, больше не участник. Ротация защитит все будущие чтения, ' +
      'но не отменит того, что уже успели открыть.',
    rotateAndRevoke: 'Ротировать ключ и отозвать старые копии',
    readOnly: 'Включён режим только для чтения, поэтому ключ нельзя ротировать с этого устройства.',
    history: 'История доступа',
    historyPrivate:
      'История показывает, кто с кем работает, поэтому её видят только владельцы и администраторы.',
    historyEmpty: 'В этом хранилище пока ничего не переходило из рук в руки.',
    removedAccount: 'удалённый аккаунт',
    older: 'Показать более ранние',
    footer: 'Сервер хранит идентификаторы, а не имена',
  },

  audit: {
    names: {
      'member.joined': 'Присоединение',
      'member.role_changed': 'Смена роли',
      'member.removed': 'Удаление участника',
      'grant.set': 'Выдача доступа',
      'grant.cleared': 'Сброс доступа',
      'invite.created': 'Создание приглашения',
      'invite.revoked': 'Отзыв приглашения',
      'key.protected': 'Собственный ключ',
      'key.rotated': 'Ротация ключа',
    },

    // Родительный: «ключ папки», «у папки», «для папки» — один падеж на все три сюжета ниже.
    targets: {
      vault: 'хранилища',
      folder: (name: string) => `папки «${name}»`,
      folderId: (id: number | undefined) => `папки №${id ?? '?'}`,
      note: (id: number | undefined) => `заметки №${id ?? '?'}`,
    },

    // Impersonal rather than «выдал»: the actor's name sits on the line below and Russian
    // has no genderless past tense, so an active verb would guess at half the readers.
    actions: {
      'member.joined': (role: string | null) =>
        role === null
          ? 'Присоединение к хранилищу'
          : `Присоединение к хранилищу с ролью «${role}»`,
      'member.role_changed': (role: string | null) =>
        role === null ? 'Роль участника изменена' : `Роль участника изменена на «${role}»`,
      'member.removed': 'Участник убран из хранилища',
      'grant.set': (target: string, permission: string | null) =>
        permission === null
          ? `Для ${target} задан доступ`
          : `Для ${target} задан доступ «${permission}»`,
      'grant.cleared': 'Доступ сброшен до унаследованного',
      'invite.created': (byCode: boolean) =>
        byCode ? 'Создано приглашение по коду' : 'Создано приглашение',
      'invite.revoked': 'Приглашение отозвано',
      'key.protected': (target: string) => `У ${target} появился собственный ключ`,
      'key.rotated': (target: string, keyVersion: string) =>
        `Ключ ${target} ротирован до версии ${keyVersion}`,
    },
  },
} satisfies Messages['access'];
