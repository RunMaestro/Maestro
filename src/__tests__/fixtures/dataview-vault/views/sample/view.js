// Custom view for the dv.view test. `input` is the second argument to dv.view.
const title = input && input.title ? input.title : 'Sample view';
dv.header(3, title);
dv.el('div', 'Rendered by views/sample/view.js', { cls: 'sample-view' });
dv.list(dv.pages('"People"').file.name);
