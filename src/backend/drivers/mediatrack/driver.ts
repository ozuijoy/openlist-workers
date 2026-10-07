import {
  calcFileType,
  FileItem,
  StorageDriver,
} from "../../internal/driver/base"
import { sortFileItems } from "../../internal/driver/sort"
import {
  MediatrackAddition,
  MediatrackFile,
  MediatrackUploadResp,
} from "./types"
import { MediatrackApiClient } from "./util"

export class MediatrackDriver implements StorageDriver {
  private addition: MediatrackAddition
  private client: MediatrackApiClient
  private rootId: string = ""
  private idCache: Map<string, string> = new Map()

  constructor(addition: MediatrackAddition) {
    this.addition = addition
    this.rootId = addition.root_folder_id || ""
    this.client = new MediatrackApiClient(addition)
  }

  async init(): Promise<void> {
    await this.client.init()
  }

  private cleanPath(p: string): string {
    const s = "/" + (p || "").split("/").filter(Boolean).join("/")
    return s === "/" ? "" : s
  }

  private async resolveParentId(physicalPath: string): Promise<string> {
    const clean = this.cleanPath(physicalPath)
    if (!clean) return this.rootId

    if (this.idCache.has(clean)) {
      return this.idCache.get(clean)!
    }

    const parts = clean.split("/").filter(Boolean)
    let currentId = this.rootId
    let currentPath = ""

    for (const part of parts) {
      currentPath += "/" + part
      if (this.idCache.has(currentPath)) {
        currentId = this.idCache.get(currentPath)!
        continue
      }

      const files = await this.client.getFiles(currentId)
      const found = files.find((f) => f.title === part)
      if (!found) {
        throw new Error(`Path not found: ${currentPath}`)
      }
      currentId = found.id
      this.idCache.set(currentPath, currentId)
    }

    return currentId
  }

  async list(virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    const parentId = await this.resolveParentId(physicalPath)
    const files = await this.client.getFiles(parentId)
    const cleanParent = this.cleanPath(physicalPath)

    const items: FileItem[] = files.map((f) => {
      const isDir = !f.file
      const filePath = cleanParent ? `${cleanParent}/${f.title}` : `/${f.title}`
      this.idCache.set(filePath, f.id)

      let thumb = ""
      if (f.file && f.file.cover) {
        thumb = "https://nano.mtres.cn/" + f.file.cover
      }

      return {
        name: f.title,
        size: parseInt(f.size || "0", 10) || 0,
        is_dir: isDir,
        created: f.created_at,
        modified: f.updated_at || new Date().toISOString(),
        sign: f.id,
        type: calcFileType(f.title, isDir),
        thumb,
        raw_url: "",
      }
    })

    return sortFileItems(
      items,
      this.addition.order_by,
      this.addition.order_desc ? "desc" : "asc",
    )
  }

  async get(virtualPath: string, physicalPath: string): Promise<FileItem> {
    const clean = this.cleanPath(physicalPath)
    const name = clean.split("/").pop() || "root"

    if (!clean) {
      return {
        name: "root",
        size: 0,
        is_dir: true,
        modified: new Date().toISOString(),
        sign: this.rootId,
        type: 1,
        raw_url: "",
      }
    }

    const parentPath = clean.split("/").slice(0, -1).join("/")
    const parentId = await this.resolveParentId(parentPath)
    const files = await this.client.getFiles(parentId)
    const found = files.find((f) => f.title === name)

    if (!found) {
      return {
        name,
        size: 0,
        is_dir: false,
        modified: new Date().toISOString(),
        sign: "",
        type: 0,
        raw_url: "",
      }
    }

    const isDir = !found.file
    let rawUrl = ""
    if (!isDir) {
      try {
        rawUrl = await this.client.getDownloadUrl(found.id)
      } catch (e) {
        console.warn("[MediaTrack] get download URL failed:", e)
      }
    }

    let thumb = ""
    if (found.file && found.file.cover) {
      thumb = "https://nano.mtres.cn/" + found.file.cover
    }

    return {
      name: found.title,
      size: parseInt(found.size || "0", 10) || 0,
      is_dir: isDir,
      created: found.created_at,
      modified: found.updated_at || new Date().toISOString(),
      sign: found.id,
      type: calcFileType(found.title, isDir),
      thumb,
      raw_url: rawUrl,
    }
  }

  async mkdir(virtualPath: string, physicalPath: string): Promise<void> {
    const clean = this.cleanPath(physicalPath)
    const parentPath = clean.split("/").slice(0, -1).join("/")
    const dirName = clean.split("/").pop() || ""
    const parentId = await this.resolveParentId(parentPath)

    await this.client.request(
      `https://jayce.api.mediatrack.cn/v3/assets/${encodeURIComponent(parentId)}/children`,
      {
        method: "POST",
        body: {
          type: 1,
          title: dirName,
        },
      },
    )
  }

  async rename(
    virtualPath: string,
    physicalPath: string,
    newName: string,
  ): Promise<void> {
    const assetId = await this.resolveParentId(physicalPath)
    await this.client.request(
      `https://jayce.api.mediatrack.cn/v3/assets/${encodeURIComponent(assetId)}`,
      {
        method: "PUT",
        body: {
          title: newName,
        },
      },
    )

    const clean = this.cleanPath(physicalPath)
    this.idCache.delete(clean)
  }

  async remove(
    virtualPath: string,
    physicalPath: string,
    names: string[],
  ): Promise<void> {
    // physicalPath 是目標項自身的物理路徑（op/storage.ts removeItems 逐項調用），
    // 目標名取參數末段、父目錄取去掉末段後的部分；resolveParentId 解析的是
    // 傳入路徑自身的 id，把項路徑當父目錄會去 <item> 的子項裡按 title 查找
    //（相當於找 <item>/<name>），找不到時靜默跳過，對象仍然存在。
    const clean = this.cleanPath(physicalPath)
    const name = clean.split("/").pop() || ""
    const parentPath = clean.split("/").slice(0, -1).join("/")
    const parentId = await this.resolveParentId(parentPath)
    const files = await this.client.getFiles(parentId)
    const match = files.find((f) => f.title === name)
    if (!match) return

    await this.client.request(
      "https://jayce.api.mediatrack.cn/v4/assets/batch/delete",
      {
        method: "DELETE",
        body: {
          origin_id: parentId,
          ids: [match.id],
        },
      },
    )

    this.idCache.delete(clean)
  }

  async move(
    srcDir: string,
    dstDir: string,
    names: string[],
    srcPhys: string,
    dstPhys: string,
  ): Promise<void> {
    // srcPhys/dstPhys 是源/目標項自身的物理路徑（已含 name），父目錄取去掉
    // 末段後的部分：源側在其父目錄的子項裡按 title 找，目標側解析目標項所在
    // 目錄的 id。把項路徑當父目錄解析會指到項本身：源側永遠落空，
    // 目標側解析一個尚不存在的目標項必然報錯。
    const srcClean = this.cleanPath(srcPhys)
    const dstClean = this.cleanPath(dstPhys)
    const srcName = srcClean.split("/").pop() || ""
    const srcParentPath = srcClean.split("/").slice(0, -1).join("/")
    const dstParentPath = dstClean.split("/").slice(0, -1).join("/")

    const srcParentId = await this.resolveParentId(srcParentPath)
    const dstParentId = await this.resolveParentId(dstParentPath)
    const srcFiles = await this.client.getFiles(srcParentId)
    const match = srcFiles.find((f) => f.title === srcName)
    if (!match) return

    await this.client.request(
      "https://jayce.api.mediatrack.cn/v4/assets/batch/move",
      {
        method: "POST",
        body: {
          parent_id: dstParentId,
          ids: [match.id],
        },
      },
    )
  }

  async copy(
    srcDir: string,
    dstDir: string,
    names: string[],
    srcPhys: string,
    dstPhys: string,
  ): Promise<void> {
    // 與 move 同理：源/目標項自身路徑先去掉末段得到父目錄，目標名取源路徑末段。
    const srcClean = this.cleanPath(srcPhys)
    const dstClean = this.cleanPath(dstPhys)
    const srcName = srcClean.split("/").pop() || ""
    const srcParentPath = srcClean.split("/").slice(0, -1).join("/")
    const dstParentPath = dstClean.split("/").slice(0, -1).join("/")

    const srcParentId = await this.resolveParentId(srcParentPath)
    const dstParentId = await this.resolveParentId(dstParentPath)
    const srcFiles = await this.client.getFiles(srcParentId)
    const match = srcFiles.find((f) => f.title === srcName)
    if (!match) return

    await this.client.request(
      "https://jayce.api.mediatrack.cn/v4/assets/batch/clone",
      {
        method: "POST",
        body: {
          parent_id: dstParentId,
          ids: [match.id],
        },
      },
    )
  }

  async put(
    virtualPath: string,
    physicalPath: string,
    content: Buffer,
  ): Promise<void> {
    const clean = this.cleanPath(physicalPath)
    const parentPath = clean.split("/").slice(0, -1).join("/")
    const fileName = clean.split("/").pop() || "upload"
    const parentId = await this.resolveParentId(parentPath)

    const randomId = Math.random().toString(36).slice(2)
    const srcKey = `assets/${randomId}`

    const tokenResp: MediatrackUploadResp = await this.client.request(
      "https://jayce.api.mediatrack.cn/v3/storage/tokens/asset",
      {
        method: "GET",
        params: { src: srcKey },
      },
    )

    const cosUrl = tokenResp.data?.url
    if (cosUrl) {
      await fetch(cosUrl, {
        method: "PUT",
        headers: {
          "Content-Length": String(content.length),
        },
        body: new Uint8Array(content),
      })
    }

    await this.client.request(
      `https://jayce.api.mediatrack.cn/v3/assets/${encodeURIComponent(parentId)}/children`,
      {
        method: "POST",
        body: {
          category: 0,
          description: fileName,
          mime: "application/octet-stream",
          size: String(content.length),
          src: srcKey,
          title: fileName,
          type: 0,
        },
      },
    )
  }
}
