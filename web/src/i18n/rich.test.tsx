import { renderToStaticMarkup } from 'react-dom/server';

import { m } from './messages';

/**
 * The messages that carry a node write the whole sentence themselves, so the only thing
 * worth asserting is that the node ends up inside it. No DOM and no testing library: the
 * server renderer already ships with react-dom.
 */
describe('messages with a node in them', () => {
  it('wrap the node in the translated sentence', () => {
    const html = renderToStaticMarkup(m.uiRich.typeToConfirm(<b>дима</b>));

    expect(html).toContain('<b>дима</b>');
    expect(html).toContain('Введите');
    expect(html).toContain('подтвердить');
  });
});
