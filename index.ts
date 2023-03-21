// === generic scheduler & its debugger
const debug = false // toggle this for manually stepping through animation frames (press key A)
let debugTimestamp = 0
let scheduledRender = false
function scheduleRender(debugForceRender = false) {
  if (debug && !debugForceRender) return
  if (scheduledRender) return
  scheduledRender = true

  requestAnimationFrame(function renderAndMaybeScheduleAnotherRender(now) { // eye-grabbing name. No "(anonymous)" function in the debugger & profiler
    scheduledRender = false
    debugTimestamp += 1000 / 60
    if (render(debug ? debugTimestamp : now)) scheduleRender()
  })
}

// === constants
const defaultCode = `void mainImage( out vec4 fragColor, in vec2 fragCoord ) {
  vec2 uv = (2.*fragCoord.xy - iResolution.xy) / iResolution.y;

  float dist = length(uv) - .5;
  float angle = atan(uv.y, uv.x);

  vec4 s = 0.1 * cos(1.5 * vec4(0,1,2,3) + iTime + angle + sin(angle) * cos(iTime)),
  e = s.yzwx,
  bg = max(dist - s, e - dist);

  fragColor = dot(clamp(bg * iResolution.y, 0., 1.), 72. * (s - e)) * (s - .1) + bg;
}`

// === state
let codes_ = localStorage.getItem(`codes`)
let codes = codes_ ? JSON.parse(codes_) : []
for (let i = codes.length; i < 8; i++) codes.push(defaultCode) // fill codes with defaultCode til it has 8 elements

let editors: {
  canvasNode: HTMLCanvasElement, editorNode: HTMLDivElement,
  codeMirror: any,
  errorMarks: any[],
  gl: WebGLRenderingContext,
  changed: boolean,
  program: WebGLProgram,
  fragmentShader: WebGLShader,
  uRes: WebGLUniformLocation | null, uTime: WebGLUniformLocation | null, uMouse: WebGLUniformLocation | null,
}[] = []
for (let i = 0; i < codes.length; i++) {
  const canvasNode = document.createElement('canvas')
  const editorNode = document.createElement('div')
  editorNode.className = "editor"
  document.body.append(canvasNode, editorNode)
  // @ts-ignore
  const codeMirror = CodeMirror(editorNode, { // needs to come after append
    value: codes[i],
    mode: "x-shader/x-fragment",
    theme: "material",
    lineNumbers: true,
    lineWrapping: true,
    // keyMap: "vim",
  })
  codeMirror.setSize("100%", "100%")

  let gl = canvasNode.getContext("webgl")!
  let program = gl.createProgram()!
  const dummyVertexShader = gl.createShader(gl.VERTEX_SHADER)!
  gl.shaderSource(dummyVertexShader, "attribute vec4 a_position; void main() {gl_Position = a_position;}")
  gl.compileShader(dummyVertexShader)
  gl.attachShader(program, dummyVertexShader)

  const fragmentShader = gl.createShader(gl.FRAGMENT_SHADER)!
  gl.shaderSource(fragmentShader, `precision mediump float; uniform vec3 iResolution; uniform float iTime; uniform vec4 iMouse;
${codeMirror.getValue()}
void main() {
  vec4 fragColor;
  mainImage(fragColor, gl_FragCoord.xy);
  gl_FragColor = vec4(fragColor.xyz, 1.0);
}`)
  gl.compileShader(fragmentShader)
  gl.attachShader(program, fragmentShader)

  let editor = {
    canvasNode, editorNode,
    codeMirror,
    errorMarks: [],
    gl,
    changed: true,
    program,
    fragmentShader,
    uRes: null, uTime: null, uMouse: null,
  }
  codeMirror.on("change", () => { // TODO: minimize dynamic events
    editor.changed = true
    scheduleRender()
  })

  editors.push(editor)
}
let inputs: {
  pointerState: 'up' | 'down' | 'firstDown',
  pointer: { x: number, y: number },
} = {
  pointerState: 'up',
  pointer: { x: -Infinity, y: -Infinity }, // btw, on page load, there's no way to render a first cursor state =(
}

// === events
window.addEventListener('resize', () => scheduleRender())
window.addEventListener("mouseup", (e) => {
  inputs.pointerState = 'up'
  scheduleRender()
})
window.addEventListener("mousemove", (e) => {
  // when scrolling (which might schedule a render), a container's mousemove doesn't trigger, so the pointer's local coordinates are stale
  // this means we should only use pointer's global coordinates, which is always right (thus the subtraction of scroll)
  inputs.pointer.x = e.pageX -/*toGlobal*/window.scrollX; inputs.pointer.y = e.pageY -/*toGlobal*/window.scrollY
  // btw, pointer can exceed document bounds, e.g. dragging reports back out-of-bound, legal negative values
  scheduleRender()
})
window.addEventListener('mousedown', (e) => {
  inputs.pointerState = 'firstDown'
  // needed to update coords even when we already track pointermove. E.g. in Chrome, right click context menu, move elsewhere, then click to dismiss. BAM, pointermove triggers with stale/wrong (??) coordinates... Click again without moving, and now you're clicking on the wrong thing
  inputs.pointer.x = e.pageX -/*toGlobal*/window.scrollX; inputs.pointer.y = e.pageY -/*toGlobal*/window.scrollY
  // btw, pointer can exceed document bounds, e.g. dragging reports back out-of-bound, legal negative values
  scheduleRender()
})

// === hit testing logic. Boxes' hit area should be static and not follow their current animated state usually (but we can do either)
// used below to check if canvas' hit area is under the pointer
function hitTest(top: number, left: number, sizeX: number, sizeY: number, x: number, y: number) {
  return top <= y && y <= top + sizeY && left <= x && x <= left + sizeX
}


function render(now: number) {
  // === step 1: batched DOM reads (to avoid accidental DOM read & write interleaving)
  const windowSizeX = document.documentElement.clientWidth // excludes scroll bar & invariant under safari pinch zoom
  const windowSizeY = document.documentElement.clientHeight // same
  const { devicePixelRatio, scrollX, scrollY } = window

  let stillAnimating = true

  // === step 5: render. Batch DOM writes
  let playgroundGap = 12
  let editorSizeX = 600
  let canvasSizeX = editorSizeX, canvasSizeY = editorSizeX / 2
  let canvasRetinaSizeX = canvasSizeX * devicePixelRatio, canvasRetinaSizeY = canvasSizeY * devicePixelRatio

  let left = playgroundGap
  for (let i = 0; i < editors.length; i++) {
    let editor = editors[i]
    const { editorNode, changed, codeMirror, canvasNode, gl, program, fragmentShader } = editor

    const canvasTop = playgroundGap, canvasLeft = left
    canvasNode.style.width = `${canvasSizeX}px`
    canvasNode.style.height = `${canvasSizeY}px`
    canvasNode.style.left = `${canvasLeft}px`
    canvasNode.style.top = `${canvasTop}px`
    canvasNode.width = canvasRetinaSizeX // different than canvasNode.style.width. Btw this clears the canvas as well
    canvasNode.height = canvasRetinaSizeY

    editorNode.style.width = `${editorSizeX}px`
    editorNode.style.top = `${canvasTop + canvasSizeY}px`
    editorNode.style.height = `${windowSizeY - playgroundGap * 2 - canvasSizeY}px`
    editorNode.style.left = `${canvasLeft}px`

    if (changed) {
      // Clear previous error highlights
      editor.errorMarks.forEach(clear => clear())
      editor.errorMarks = [] // TODO: no double assign

      let newFragmentShader = gl.createShader(gl.FRAGMENT_SHADER)!
      const newCode = codeMirror.getValue()
      gl.shaderSource(
        newFragmentShader,
        `precision mediump float; uniform vec3 iResolution; uniform float iTime; uniform vec4 iMouse;
${newCode}
void main() {
  vec4 fragColor;
  mainImage(fragColor, gl_FragCoord.xy);
  gl_FragColor = vec4(fragColor.xyz, 1.0);
}`)
      gl.compileShader(newFragmentShader)
      if (!gl.getShaderParameter(newFragmentShader, gl.COMPILE_STATUS)) { // TODO: get all other errors (e.g. link errors)
        let errorsRaw = gl.getShaderInfoLog(newFragmentShader)!
        const errorRegex = /ERROR: \d+:(\d+): (.+)/g // e.g. "ERROR: 0:14: '{' : syntax error\nERROR: 1:13 ..."

        let errors: { line: number, messages: string[] }[] = []
        for (const [, line, message] of errorsRaw.matchAll(errorRegex)) {
          const lineNumber = parseInt(line) - 2
          if (errors.length === 0 || errors.at(-1)!.line !== lineNumber) {
            errors.push({ line: lineNumber, messages: [] })
          }
          errors.at(-1)!.messages.push(message)
        }

        editor.errorMarks = errors.map(({ line, messages }) => {
          const tooltip = document.createElement("div")
          tooltip.className = "error-tooltip"
          tooltip.innerHTML = messages.join("<br>")
          tooltip.style.display = "none"
          document.body.appendChild(tooltip)

          const mark = document.createElement("div")
          mark.innerText = '!!'
          codeMirror.setGutterMarker(line, "CodeMirror-linenumbers", mark)

          const onMouseOver = (e: MouseEvent) => {
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
            tooltip.style.left = `${rect.right + 10}px`
            tooltip.style.top = `${rect.top}px`
            tooltip.style.display = "block"
          }

          const onMouseOut = () => {
            tooltip.style.display = "none"
          }

          mark.addEventListener("mouseover", onMouseOver)
          mark.addEventListener("mouseout", onMouseOut)

          return (() => {
            codeMirror.clearGutter("CodeMirror-linenumbers")
            mark.removeEventListener("mouseover", onMouseOver)
            mark.removeEventListener("mouseout", onMouseOut)
            document.body.removeChild(tooltip)
          })
        })
      } else {
        editor.fragmentShader = newFragmentShader
        gl.detachShader(program, fragmentShader)
        gl.deleteShader(fragmentShader)
        gl.attachShader(program, newFragmentShader)
        gl.linkProgram(program)
        gl.useProgram(program)
        gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer()) // set up the dummy vertex shader's buffer
        gl.bufferData(
          gl.ARRAY_BUFFER,
          new Float32Array([-1, 1, 1, 1, -1, -1, 1, -1]), // 4 vertices (4 times x,y)
          gl.STATIC_DRAW // we don't update the vertices after creating the buffer (we do destroy the program per keystroke though, but not per rAF)
        )
        const aPosition = gl.getAttribLocation(program, "a_position")
        gl.vertexAttribPointer(
          aPosition,
          2, // 2 components per attribute
          gl.FLOAT,
          false, // don't normalize the data. Aka, don't convert from whatever range to 0-1. Irrelevant for us
          0, // stride
          0 // offset
        )
        gl.enableVertexAttribArray(aPosition)
      }
    }
    gl.viewport(0, 0, canvasRetinaSizeX, canvasRetinaSizeY) // needs to come after canvas width/height change, otherwise flash
    let uRes = gl.getUniformLocation(program, "iResolution")
    let uTime = gl.getUniformLocation(program, "iTime")
    let uMouse = gl.getUniformLocation(program, "iMouse")
    // pass in shader variable values
    gl.uniform3f(uRes, canvasRetinaSizeX, canvasRetinaSizeY, 1.0)
    gl.uniform1f(uTime, now * 0.001)
    let pointerX = inputs.pointer.x +/*toLocal*/scrollX
    let pointerY = inputs.pointer.y +/*toLocal*/scrollY
    const hit = hitTest(canvasTop, canvasLeft, canvasSizeX, canvasSizeY, pointerX, pointerY)
    let x, y
    if (hit && inputs.pointerState !== 'up') {
      x = (pointerX -/*toLocal*/canvasLeft) * devicePixelRatio // TODO: document
      y = (canvasSizeY - (pointerY +/*toLocal*/canvasTop)) * devicePixelRatio // TODO: document
    } else {
      x = 0; y = 0
    }
    gl.uniform4f(uMouse, x, y, inputs.pointerState === 'up' ? 0 : 1, inputs.pointerState === 'firstDown' ? 1 : 0)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)

    left += editorSizeX + 20 // gap
  }

  if (editors.some(e => e.changed)) {
    let newCodes = editors.map(e => e.codeMirror.getValue())
    localStorage.setItem("codes", JSON.stringify(newCodes))
  }

  // === step 6: update state & prepare for next frame
  if (inputs.pointerState === 'firstDown') inputs.pointerState = 'down'
  for (let i = 0; i < editors.length; i++) editors[i].changed = false

  return stillAnimating
}

scheduleRender()
