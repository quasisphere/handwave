export const handwaveMathJaxConfiguration = {
  tex: {
    inlineMath: [["$", "$"], ["\\(", "\\)"]],
    displayMath: [["$$", "$$"], ["\\[", "\\]"]],
    processEscapes: true,
    macros: {
      fint: "\\rlap{\\mkern2mu-}\\!\\int"
    }
  },
  options: {
    skipHtmlTags: ["script", "noscript", "style", "textarea", "pre", "code"]
  }
} as const;

export function renderMathJaxConfigurationScript(): string {
  return `window.MathJax = ${JSON.stringify(handwaveMathJaxConfiguration, undefined, 2)};`;
}
