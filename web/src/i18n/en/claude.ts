/**
 * The connector, in three surfaces: the dialog that hands this server a key, the view of the
 * vault it can read, and the consent screen an OAuth client is sent to.
 *
 * Nothing here spells a folder, a document or a status. `projects/`, `CLAUDE.md` and
 * `**Status:** active` are what a model is told to walk and what `claudeview.ts` matches a
 * folder name against — they live in `lib/claudeos-contract.ts` and are the same in every
 * language. What is written here is the label a person reads beside them.
 */

import { countedEn } from '../plural';

export const claude = {
  connect: {
    title: 'Connect Claude',
    titleDone: 'Claude is connected',
    subtitle: 'A vault laid out as Claude’s memory',
    subtitleDone: 'One vault, readable by this server',

    lede:
      'This creates a vault holding a ready-made structure — context, projects, skills, ' +
      'memory and an inbox — and hands its key to this server so that Claude can read and ' +
      'write it over the connector.',

    warnLead: 'This server will be able to read this vault.',
    warnBody:
      'Every folder name, every title and every body. It is the only place in Shelf where ' +
      'that is true, and it is what makes a connector possible at all. Anything Claude reads ' +
      'here also leaves for Anthropic. Your other vaults are untouched: this server holds no ' +
      'key to them and cannot obtain one.',

    acceptKey: 'I understand this server will hold the key to this vault, and accept it.',
    acceptNoSecrets:
      'I will not keep passwords, keys, recovery codes or other people’s personal data here.',

    nameLabel: 'Vault name',
    /** The name the vault is created with, so it is content rather than a label. */
    nameInitial: 'Claude',

    mayDo: 'What Claude may do',
    editor: 'Read and write',
    editorHint: 'Claude keeps its own memory and project notes.',
    viewer: 'Read only',
    viewerHint: 'Claude can look things up but never writes.',

    creating: 'Creating…',
    create: 'Create and connect',

    /** The vault is made first and connected second, so half of it can succeed. */
    halfMade: (why: string) =>
      `The vault was created but could not be connected. ${why} It is in the vault menu — ` +
      'connect it again from there, or delete it.',

    /** Written on the credential this dialog issues, and read back in the credential list. */
    firstClient: 'first client',

    footerOnce: 'The credential is shown once',
    footerRevocable: 'Revocable from the vault menu',
    footerNothing: 'Nothing was created',

    off: {
      lede:
        'This server is not set up to serve a connector, so a vault made here could not be ' +
        'connected to Claude. Nothing has been created.',
      note:
        'It is off by default, because it is the one feature that hands this server a key. ' +
        'Turning it on is three settings and a restart.',
      section: 'What to set',
      /** The path is passed in rather than written: it is a path, and it is not translated. */
      secretNote: (path: string) => `at least 32 characters, and never in ${path}`,
      urlNote: 'exactly the address Claude will be given',
      noFallback:
        'The secret has no fallback anywhere, local included: one generated at startup would ' +
        'make every connector key already stored unreadable after the first restart.',
    },

    done: {
      /** Follows the vault's name, which is set in bold by the markup around it. */
      lede: (notes: number, folders: number) =>
        `holds ${countedEn(notes, ['note', 'notes'])} in ` +
        `${countedEn(folders, ['folder', 'folders'])}, and this server now has its key.`,
      urlSection: 'Connector URL',
      localNote:
        'Claude Desktop reaches a connector from Anthropic’s own network, so an address on ' +
        'this machine is not one it can call. Claude Code can, from here:',
      credentialSection: 'Credential',
      credentialNote:
        'Paste it whole, scheme included. It is shown once — what this server keeps is a ' +
        'digest, so a lost one is replaced rather than recovered.',
      fingerprintSection: 'Key fingerprint',
      undoSection: 'To undo this',
      undoRemove: 'Remove the connector from this vault’s members.',
      undoRotate:
        'Rotate the vault key afterwards — removing it stops new reads, rotating is what ' +
        'makes the key it already saw useless.',
    },
  },

  view: {
    connected: (role: string, fingerprint: string) =>
      `Connected as ${role.toLowerCase()} · ${fingerprint}`,
    noConnector: 'No connector on this vault — Claude cannot see it',
    instructions: 'Instructions',
    reading: (covered: number, total: number) =>
      `Reading the vault — ${covered} of ${total} notes open so far.`,

    projects: 'Projects',
    newProject: 'New project',
    projectName: 'Project name',
    noProjects: 'Nothing on the go. A project is a folder with a CLAUDE.md in it.',

    changed: 'What Claude changed',
    noChanges: 'Nothing yet. Anything the connector writes shows up here first.',

    memory: 'Memory',
    noMemory: 'No log yet. Months live in memory/ as YYYY-MM.md.',
    entries: (count: number) => countedEn(count, ['entry', 'entries']),

    skills: 'Skills',
    newSkill: 'New skill',
    skillName: 'Skill name',
    noSkills: 'None written. A skill is a procedure worth repeating exactly.',
    notWritten: 'not written yet',

    context: 'Context',
    noContext: 'No standing facts. These are what Claude reads before answering.',
    blank: 'blank',

    inbox: 'Inbox',
    elsewhere: 'Outside the five areas',
    /** Where a note with no folder sits. */
    root: 'root',

    /** A project created from the template and not touched since. */
    fresh: 'new',
    unfilled: 'Nobody has filled this in yet.',
    noSummary: 'No description.',
    notes: (count: number) => countedEn(count, ['note', 'notes']),
    decided: (count: number) => `${count} decided`,
    done: (count: number) => `${count} done`,
  },

  consent: {
    title: 'Connect to Shelf',
    checking: 'Checking who is asking…',
    someClient: 'An MCP client',
    asking: (client: string) => `${client} wants to reach one of your vaults`,

    nothing: 'Nothing here can be approved',
    linkIncomplete: 'This link is missing what it needs.',
    methodRefused: 'This client asked for a challenge method this server refuses.',
    clientUnknown: 'That client is not registered with this server.',

    noneBefore: 'None of your vaults has a connector yet. Set one up from the vault menu —',
    /** The same words as the item in the vault menu, because it is being pointed at. */
    menuItem: 'Connect Claude…',
    noneAfter: '— and come back to this link.',

    ledeOne:
      'Approving lets this client read the vault below through the connector, and write to ' +
      'it where the connector may. It does not give the client anything else in your account.',
    ledeMany:
      'Approving lets this client read the vault you pick through the connector, and write ' +
      'to it where the connector may. It does not give the client anything else in your ' +
      'account.',

    vaultSection: 'Vault',
    notes: (count: number) => countedEn(count, ['note', 'notes']),

    returning: 'Returning to',
    addressNote:
      'Check that address. It is where the client will be handed the code, and a loopback ' +
      'one belongs to whatever is listening on this machine.',

    footerKey: 'This server already holds that vault’s key',
    deny: 'Deny',
    approving: 'Approving…',
    allow: 'Allow',
  },
};
