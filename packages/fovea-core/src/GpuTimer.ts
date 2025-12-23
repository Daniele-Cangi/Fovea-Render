export class GpuTimer {
  private gl: WebGL2RenderingContext;
  private ext: any | null = null;
  private query: WebGLQuery | null = null;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.ext = gl.getExtension("EXT_disjoint_timer_query_webgl2");
  }

  get supported() { return !!this.ext; }

  begin() {
    if (!this.ext) return;
    if (!this.query) this.query = this.gl.createQuery();
    if (!this.query) return;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, this.query);
  }

  end() {
    if (!this.ext || !this.query) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
  }

  // returns GPU ms if available, else null
  poll(): number | null {
    if (!this.ext || !this.query) return null;

    const available = this.gl.getQueryParameter(this.query, this.gl.QUERY_RESULT_AVAILABLE);
    const disjoint = this.gl.getParameter(this.ext.GPU_DISJOINT_EXT);

    if (!available || disjoint) return null;

    const ns = this.gl.getQueryParameter(this.query, this.gl.QUERY_RESULT) as number;
    return ns / 1e6;
  }
}

