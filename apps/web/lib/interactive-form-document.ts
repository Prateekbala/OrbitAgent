import { formFields } from '@ao/contracts/tools';

const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!,
  );

const styles = `
* { box-sizing: border-box; }
body { font: 14px/1.6 system-ui; padding: 18px; margin: 0; background: Canvas; color: CanvasText; }
h2 { font-size: 19px; margin: 0 0 8px; }
p { margin: 0 0 18px; opacity: .8; }
label { display: block; margin: 14px 0; font-size: 13px; font-weight: 550; }
input { display: block; width: 100%; padding: 10px; margin-top: 6px; border: 1px solid GrayText; border-radius: 6px; background: Field; color: FieldText; font: inherit; accent-color: #f8cb46; }
input[type=checkbox] { display: inline-block; width: auto; margin-right: 8px; }
input:focus-visible { outline: 2px solid #f8cb46; outline-offset: 2px; }
button { padding: 10px 14px; border: 0; border-radius: 7px; font: inherit; font-weight: 600; background: #f8cb46; color: #282315; cursor: pointer; }
button:focus-visible { outline: 2px solid #f8cb46; outline-offset: 3px; }
`;

export function interactiveFormDocument(
  form: { title: string; description: string; fields: unknown },
  nonce: string,
  theme: 'light' | 'dark',
) {
  const controls = formFields
    .parse(form.fields)
    .map(
      (field) =>
        `<label>${escape(field.label)}<input name="${escape(field.name)}" type="${field.type === 'boolean' ? 'checkbox' : field.type === 'number' ? 'number' : 'text'}" ${field.required ? 'required' : ''} maxlength="2000"></label>`,
    )
    .join('');
  const script = `
const nonce = ${JSON.stringify(nonce)};
addEventListener('message', event => {
  const data = event.data;
  if (event.source !== parent || !data || data.type !== 'orbit.appearance' || data.nonce !== nonce || !['light', 'dark'].includes(data.theme)) return;
  document.documentElement.style.colorScheme = data.theme;
});
document.querySelector('button').addEventListener('click', () => {
  const form = document.querySelector('form'), values = {};
  if (!form.reportValidity()) return;
  for (const input of form.querySelectorAll('input')) values[input.name] = input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value;
  parent.postMessage({ type: 'orbit.form', nonce, values }, '*');
});`;
  return `<!doctype html><html style="color-scheme:${theme}"><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; form-action 'none'; connect-src 'none'; img-src 'none'; base-uri 'none'"><style>${styles}</style></head><body><h2>${escape(form.title)}</h2><p>${escape(form.description)}</p><form>${controls}<button type="button">Review form response</button></form><script nonce="${nonce}">${script}</script></body></html>`;
}
