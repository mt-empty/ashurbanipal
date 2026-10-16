// Colouring for a text field by drawing a copy behind it (the field's own text
// goes transparent), so the native caret, selection and IME keep working.
// Re-renders on typing, on programmatic `.value` writes (which fire no input
// event), and when the field's own width changes — a scrollbar appearing or a
// layout change narrows it without a window resize.
export function attachOverlayHighlight(field: HTMLInputElement | HTMLTextAreaElement, render: () => void): void {
  const proto = field instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  const valueProp = Object.getOwnPropertyDescriptor(proto, "value");
  if (valueProp?.get && valueProp.set) {
    const { get, set } = valueProp;
    Object.defineProperty(field, "value", {
      configurable: true,
      get() {
        return get.call(this);
      },
      set(v: string) {
        set.call(this, v);
        render();
      },
    });
  }
  field.addEventListener("input", render);
  // Also renders once on observe.
  new ResizeObserver(render).observe(field);
  render();
}
