// Virtual driver — 虛擬目錄驅動（壓測 / 佔位）
// 移植自 OpenList Go 版 drivers/virtual。
// 生成指定數量的隨機佔位文件與目錄，下載時返回隨機資料流（DummyMFile）。
import {
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"

export interface VirtualAddition {
  root_folder_path?: string
  num_file: number
  num_folder: number
  max_file_size: number
  min_file_size: number
}

export class VirtualDriver implements StorageDriver {
  private addition: VirtualAddition

  constructor(addition: VirtualAddition) {
    this.addition = addition || {}
  }

  private randSize(): number {
    const min = this.addition.min_file_size || 0
    const max = this.addition.max_file_size || 0
    if (max <= min) return min
    return min + Math.floor(Math.random() * (max - min))
  }

  private now(): string {
    return new Date().toISOString()
  }

  async list(): Promise<FileItem[]> {
    const items: FileItem[] = []
    for (let i = 0; i < (this.addition.num_file || 0); i++) {
      const name = `file_${i}.bin`
      items.push({
        name,
        size: this.randSize(),
        is_dir: false,
        modified: this.now(),
        sign: "",
        type: calcFileType(name, false),
      })
    }
    for (let i = 0; i < (this.addition.num_folder || 0); i++) {
      const name = `folder_${i}`
      items.push({
        name,
        size: 0,
        is_dir: true,
        modified: this.now(),
        sign: "",
        type: 1,
      })
    }
    return items
  }

  async get(_virtualPath: string, physicalPath: string): Promise<FileItem> {
    const segs = String(physicalPath || "")
      .split("/")
      .filter(Boolean)
    const name = segs[segs.length - 1] || "file.bin"
    return {
      name,
      size: this.randSize(),
      is_dir: false,
      modified: this.now(),
      sign: "",
      type: calcFileType(name, false),
      raw_url: "",
    }
  }

  async mkdir(): Promise<void> {}
  async rename(): Promise<void> {}
  async remove(): Promise<void> {}
  async move(): Promise<void> {}
  async copy(): Promise<void> {}
  async put(): Promise<void> {}

  /**
   * 隨機資料流，支持 Range。raw.ts 檢測到 createReadStream 時走流式下載
   * （虛擬文件無真實 raw_url，因此依賴此方法返回內容）。
   */
  async createReadStream(
    _physicalPath: string,
    range?: { start: number; end: number },
  ): Promise<ReadableStream> {
    const start = range?.start ?? 0
    const end = range?.end ?? start + this.randSize() - 1
    const length = Math.max(0, end - start + 1)
    const chunkSize = 64 * 1024
    let remaining = length
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (remaining <= 0) {
          controller.close()
          return
        }
        const n = Math.min(chunkSize, remaining)
        const buf = new Uint8Array(n)
        crypto.getRandomValues(buf)
        controller.enqueue(buf)
        remaining -= n
      },
    })
  }
}
