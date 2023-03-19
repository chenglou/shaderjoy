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

// === state
let editors: {
  canvasNode: HTMLCanvasElement,
  editorNode: HTMLDivElement,
  codeMirror: any,
  gl: WebGLRenderingContext,
  changed: boolean,
  program: WebGLProgram,
  uRes: WebGLUniformLocation | null,
  uTime: WebGLUniformLocation | null,
  uMouse: WebGLUniformLocation | null,
}[] = []
for (let i = 0; i < 2; i++) {
  const canvasNode = document.createElement('canvas')
  const editorNode = document.createElement('div')
  editorNode.className = "editor"
  document.body.append(canvasNode, editorNode)
  // @ts-ignore
  const codeMirror = CodeMirror(editorNode, { // needs to come after append
    value: `void mainImage( out vec4 fragColor, in vec2 fragCoord ) {
  vec2 uv = (2.*fragCoord.xy - iResolution.xy) / iResolution.y;

  float dist = length(uv) - .5;
  float angle = atan(uv.y, uv.x);

  vec4 s = 0.1 * cos(1.5 * vec4(0,1,2,3) + iTime + angle + sin(angle) * cos(iTime)),
  e = s.yzwx,
  bg = max(dist - s, e - dist);

  fragColor = dot(clamp(bg * iResolution.y, 0., 1.), 72. * (s - e)) * (s - .1) + bg;
}`,
    mode: "x-shader/x-fragment",
    theme: "material",
    lineNumbers: true,
    lineWrapping: true,
    keyMap: "vim",
  })
  let gl = canvasNode.getContext("webgl")!

  let editor = {
    canvasNode,
    editorNode,
    codeMirror,
    gl,
    changed: true,
    program: gl.createProgram()!,
    uRes: null,
    uTime: null,
    uMouse: null,
  }
  codeMirror.on("change", () => { // TODO: minimize dynamic events
    editor.changed = true
    scheduleRender()
  })

  editors.push(editor)
}

// === events
window.addEventListener("resize", () => scheduleRender())
window.addEventListener("change", () => {
  console.log('heu')
})

function render(now: number) {
  // === step 1: batched DOM reads (to avoid accidental DOM read & write interleaving)
  const windowSizeX = document.documentElement.clientWidth // excludes scroll bar & invariant under safari pinch zoom
  const windowSizeY = document.documentElement.clientHeight // same
  const devicePixelRatio = window.devicePixelRatio

  let stillAnimating = true

  // === step 5: render. Batch DOM writes
  let editorSizeX = 640, editorSizeY = 500
  let canvasSizeX = 640, canvasSizeY = 360
  let canvasRetinaSizeX = canvasSizeX * devicePixelRatio, canvasRetinaSizeY = canvasSizeY * devicePixelRatio

  let left = 0
  for (let i = 0; i < editors.length; i++) {
    let editor = editors[i]
    const { editorNode, changed, codeMirror, canvasNode, gl, program } = editor
    editorNode.style.width = `${editorSizeX}px`
    editorNode.style.top = `${canvasSizeY}px`
    editorNode.style.left = `${left}px`

    canvasNode.style.width = `${canvasSizeX}px`
    canvasNode.style.height = `${canvasSizeY}px`
    canvasNode.style.left = `${left}px`
    canvasNode.width = canvasRetinaSizeX // different than canvasNode.style.width. Btw this clears the canvas as well
    canvasNode.height = canvasRetinaSizeY

    if (changed) {
      gl.deleteProgram(program)
      let newProgram = gl.createProgram()!
      // TODO: get all error info: getShaderParameter, getShaderInfoLog, etc.
      const dummyVertexShader = gl.createShader(gl.VERTEX_SHADER)!
      gl.shaderSource(dummyVertexShader, "attribute vec4 a_position; void main() {gl_Position = a_position;}")
      gl.compileShader(dummyVertexShader)
      gl.attachShader(newProgram, dummyVertexShader)

      const fragmentShader = gl.createShader(gl.FRAGMENT_SHADER)!
      gl.shaderSource(
        fragmentShader,
        `precision mediump float;
uniform vec3 iResolution;
uniform float iTime;
uniform vec4 iMouse;
${codeMirror.getValue()}
void main() {
  vec4 fragColor;
  mainImage(fragColor, gl_FragCoord.xy);
  gl_FragColor = vec4(fragColor.xyz, 1.0);
}`
      )
      gl.compileShader(fragmentShader)
      gl.attachShader(newProgram, fragmentShader)
      // link and use
      gl.linkProgram(newProgram)
      gl.useProgram(newProgram)
      gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer()) // set up the dummy vertex shader's buffer
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([-1, 1, 1, 1, -1, -1, 1, -1]), // 4 vertices (4 times x,y)
        gl.STATIC_DRAW // we don't update the vertices after creating the buffer (we do destroy the program per keystroke though, but not per rAF)
      )
      const aPosition = gl.getAttribLocation(newProgram, "a_position")
      gl.vertexAttribPointer(
        aPosition,
        2, // 2 components per attribute
        gl.FLOAT,
        false, // don't normalize the data. Aka, don't convert from whatever range to 0-1. Irrelevant for us
        0, // stride
        0 // offset
      )
      gl.enableVertexAttribArray(aPosition)
      editor.program = newProgram
    }
    gl.viewport(0, 0, canvasRetinaSizeX, canvasRetinaSizeY) // needs to come after canvas width/height change, otherwise flash
    let uRes = gl.getUniformLocation(editor.program, "iResolution")
    let uTime = gl.getUniformLocation(editor.program, "iTime")
    let uMouse = gl.getUniformLocation(editor.program, "iMouse")
    // pass in shader variable values
    gl.uniform3f(uRes, canvasRetinaSizeX, canvasRetinaSizeY, 1.0)
    gl.uniform1f(uTime, now * 0.001)
    gl.uniform4f(uMouse, 0, 0, 0, 0)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)

    left += editorSizeX + 20 // gap
  }

  // === step 6: update state & prepare for next frame
  for (let i = 0; i < editors.length; i++) editors[i].changed = false

  return stillAnimating
}

scheduleRender()
