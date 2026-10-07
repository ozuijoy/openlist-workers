// ProtonDrive driver — E2EE 網盤驅動（瀏覽 + 解密下載 + 基礎寫操作）
// Ported from: OpenList-Backends/drivers/proton_drive (go-proton-api + Proton-API-Bridge)
//
// 安全模型說明：Proton Drive 的文件名與文件內容均為 OpenPGP 端到端加密，
// 服務端僅儲存密文。因此本驅動必須在客戶端（此處為 Workers 運行時）完成
// 整條密鑰鏈的解鎖，才能解密出文件名與內容：
//
//   用戶私鑰 (bcrypt(password, keySalt) 解鎖)
//     └─ 地址私鑰 (Token 用用戶密鑰環解密得到 passphrase)
//         └─ 共享(share)私鑰 (Passphrase 用地址密鑰環解密)
//             └─ 根節點密鑰 → 子節點密鑰鏈 (NodePassphrase 逐級解密)
//                 └─ 文件名 / 內容會話密鑰(session key)
//
// 注意：saltedKeyPass 是 bcrypt 摘要的 printable-ASCII 形式，可直接作為
// openpgp 的 string passphrase 使用；這一點與 go-proton-api 的實現一致。
//
// 已知限制（TODO）：
//   - move/copy：需要把 NodePassphrase 用「目標父節點密鑰環」重新加密，屬於
//     跨節點重加密操作，本移植版本暫未實現（見對應方法註釋）。
//   - put/上傳：需要分塊 AEAD 加密 + draft/revision 兩階段上傳協議，暫未實現。
import {
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"
import { sortFileItems } from "../../internal/driver/sort"
import {
  ProtonDriveAddition,
  ProtonLink,
  ProtonShare,
  ProtonListResp,
} from "./types"
import { ProtonShareTypeMain } from "./consts"
import {
  ProtonDriveClient,
  unlockUserKeys,
  unlockAddressKeys,
  unlockShareKeyring,
} from "./util"
import {
  KeyRing,
  decryptArmoredText,
  decryptSessionKeyPacket,
  decryptBinaryWithSessionKey,
  decryptXAttrSize,
  encryptText,
  getNameHash,
} from "./crypto"
import * as openpgp from "openpgp"

const LIST_PAGE_SIZE = 150

function parseProtonDate(timestamp: number): string {
  if (!timestamp) return new Date().toISOString()
  return new Date(timestamp * 1000).toISOString()
}

export function normalizeProtonDriveAddition(a: any): ProtonDriveAddition {
  const norm = { ...(a || {}) } as any
  norm.email = (norm.email || "").trim()
  norm.password = (norm.password || "").trim()
  norm.two_fa_code = (norm.two_fa_code || "").trim()
  norm.root_folder_id = (norm.root_folder_id || "").trim() || "root"
  norm.use_reusable_login = !!norm.use_reusable_login
  norm.chunk_size = norm.chunk_size || "4"
  norm.reusable_credential = (norm.reusable_credential || "").trim()
  return norm as ProtonDriveAddition
}

export class ProtonDriveDriver implements StorageDriver {
  private addition: ProtonDriveAddition
  private client: ProtonDriveClient
  private mainShare: ProtonShare | null = null
  private mainShareKR: KeyRing = []
  private userKR: KeyRing = []
  private addrKRs: Map<string, KeyRing> = new Map()
  private defaultAddrKR: KeyRing = []
  private defaultAddrID = ""

  // 路徑/ID 快取
  private idCache = new Map<string, string>()
  private linkCache = new Map<string, ProtonLink>()
  private nodeKRcache = new Map<string, KeyRing>()
  private childrenCache = new Map<string, ProtonLink[]>()

  constructor(addition: any) {
    this.addition = normalizeProtonDriveAddition(addition)
    this.client = new ProtonDriveClient(this.addition)
  }

  async init(): Promise<void> {
    if (!this.addition.email) throw new Error("email is required")
    if (!this.addition.password) throw new Error("password is required")

    await this.client.login()

    const salts = await this.client.getSalts()
    const user = await this.client.getUser()
    const addresses = await this.client.getAddresses()

    // 解鎖用戶密鑰
    const { userKR, saltedKeyPass } = await unlockUserKeys(
      user.Keys,
      this.addition.password,
      salts,
    )
    this.userKR = userKR
    this.client.setSaltedKeyPass(saltedKeyPass)

    // 解鎖地址密鑰
    this.addrKRs = await unlockAddressKeys(addresses, this.userKR, saltedKeyPass)
    if (this.addrKRs.size === 0) {
      throw new Error("failed to unlock address keys")
    }

    // 默認地址（第一個地址）
    this.defaultAddrID = addresses[0]?.ID || ""
    this.defaultAddrKR = this.addrKRs.get(this.defaultAddrID) || []

    // 獲取主 share 並解鎖 share 密鑰環
    const shares = await this.client.getShares()
    this.mainShare =
      shares.find((s) => s.Type === ProtonShareTypeMain) || shares[0]
    if (!this.mainShare) throw new Error("no shares found")

    this.mainShareKR = await unlockShareKeyring(this.mainShare, this.addrKRs)

    // 預熱根節點密鑰環
    await this.getLinkKR(this.getRootLinkID())
  }

  private getShareID(): string {
    if (!this.mainShare) throw new Error("not initialized")
    return this.mainShare.ShareID
  }

  private getVolumeID(): string {
    if (!this.mainShare) throw new Error("not initialized")
    return this.mainShare.VolumeID
  }

  private getRootLinkID(): string {
    if (!this.mainShare) throw new Error("not initialized")
    if (this.addition.root_folder_id && this.addition.root_folder_id !== "root") {
      return this.addition.root_folder_id
    }
    return this.mainShare.RootLinkID
  }

  // ---------- Proton trust chain helpers ----------

  private async fetchLink(linkID: string): Promise<ProtonLink> {
    const cached = this.linkCache.get(linkID)
    if (cached) return cached
    const resp = (await this.client.requestAPI(
      `/drive/volumes/${this.getVolumeID()}/links/${linkID}`,
    )) as { Code: number; Link: ProtonLink }
    if (!resp.Link) throw new Error(`link not found: ${linkID}`)
    this.linkCache.set(linkID, resp.Link)
    return resp.Link
  }

  /** 遞歸構建節點密鑰環：nodeKR = parentKR + nodePrivateKey */
  private async getLinkKR(linkID: string): Promise<KeyRing> {
    const cached = this.nodeKRcache.get(linkID)
    if (cached) return cached

    const link = await this.fetchLink(linkID)
    const parentKR = link.ParentLinkID
      ? await this.getLinkKR(link.ParentLinkID)
      : this.mainShareKR

    const passphrase = await decryptArmoredText(link.NodePassphrase, parentKR)
    const nodeKey = await openpgp.readPrivateKey({ armoredKey: link.NodeKey })
    const unlocked = await openpgp.decryptKey({ privateKey: nodeKey, passphrase })

    const kr = [...parentKR, unlocked]
    this.nodeKRcache.set(linkID, kr)
    return kr
  }

  /** 解密文件名 */
  private async decryptName(link: ProtonLink): Promise<string> {
    if (!link.Name) return "unnamed"
    const kr = await this.getLinkKR(link.LinkID)
    try {
      return await decryptArmoredText(link.Name, kr)
    } catch {
      return "unnamed"
    }
  }

  private cleanPath(p: string): string {
    const s = "/" + (p || "").split("/").filter(Boolean).join("/")
    return s === "/" ? "/" : s
  }

  private joinPath(parent: string, name: string): string {
    return parent === "/" ? `/${name}` : `${parent}/${name}`
  }

  /** 列出某個 link 的所有子 link（帶快取 + 翻頁） */
  private async listChildren(linkID: string): Promise<ProtonLink[]> {
    const cached = this.childrenCache.get(linkID)
    if (cached) return cached

    const all: ProtonLink[] = []
    for (let page = 0; page < 1000; page++) {
      const resp = (await this.client.requestAPI(
        `/drive/volumes/${this.getVolumeID()}/links/${linkID}`,
        {
          params: {
            Children: "1",
            Page: String(page),
            PageSize: String(LIST_PAGE_SIZE),
            Thumbnail: "0",
          },
        },
      )) as ProtonListResp
      const links = resp.Links || []
      all.push(...links)
      if (links.length < LIST_PAGE_SIZE) break
    }
    this.childrenCache.set(linkID, all)
    return all
  }

  /** 名稱路徑 → linkID（遍歷解密文件名） */
  private async resolveId(path: string): Promise<string> {
    const clean = this.cleanPath(path)
    if (clean === "/") return this.getRootLinkID()
    const cached = this.idCache.get(clean)
    if (cached) return cached

    const segs = clean.split("/").filter(Boolean)
    let curId = this.getRootLinkID()
    let curPath = "/"
    for (const seg of segs) {
      const children = await this.listChildren(curId)
      let found: ProtonLink | null = null
      for (const child of children) {
        const name = await this.decryptName(child)
        if (name === seg) {
          found = child
          break
        }
      }
      if (!found) throw new Error(`folder not found: ${seg}`)
      curId = found.LinkID
      curPath = this.joinPath(curPath, seg)
      this.idCache.set(curPath, curId)
    }
    return curId
  }

  // ---------- StorageDriver ----------

  async list(virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    const linkID = await this.resolveId(physicalPath)
    const children = await this.listChildren(linkID)
    const clean = this.cleanPath(physicalPath)

    const items: FileItem[] = []
    for (const link of children) {
      const name = await this.decryptName(link)
      this.idCache.set(this.joinPath(clean, name), link.LinkID)
      const isDir = link.Type === 2
      items.push({
        name,
        size: isDir ? 0 : link.Size || 0,
        is_dir: isDir,
        modified: parseProtonDate(link.ModifyTime || link.CreateTime),
        sign: link.LinkID,
        type: calcFileType(name, isDir),
      })
    }

    return sortFileItems(items, "name", "asc")
  }

  async get(virtualPath: string, physicalPath: string): Promise<FileItem> {
    const clean = this.cleanPath(physicalPath)
    if (clean === "/") {
      return {
        name: "root",
        size: 0,
        is_dir: true,
        modified: new Date().toISOString(),
        sign: this.getRootLinkID(),
        type: 1,
      }
    }

    const linkID = await this.resolveId(clean)
    const link = await this.fetchLink(linkID)
    const name = await this.decryptName(link)
    const isDir = link.Type === 2

    // 文件大小需用解密後的真實大小（link.Size 是加密後大小）
    let size = 0
    if (!isDir) {
      const nodeKR = await this.getLinkKR(linkID)
      size = await decryptXAttrSize(link.XAttr || "", nodeKR)
      if (!size) size = link.Size || 0
    }

    return {
      name,
      size,
      is_dir: isDir,
      modified: parseProtonDate(link.ModifyTime || link.CreateTime),
      sign: linkID,
      type: calcFileType(name, isDir),
      // 無 raw_url：下載走 createReadStream（服務端解密）
      raw_url: "",
    }
  }

  /**
   * 流式解密下載。raw.ts 檢測到本方法後會用其替代 raw_url 代理。
   * 支持 Range（start/end），把字節區間映射到加密分塊並逐塊解密。
   */
  async createReadStream(
    physicalPath: string,
    options?: { start?: number; end?: number },
  ): Promise<ReadableStream<Uint8Array>> {
    const linkID = await this.resolveId(physicalPath)
    const link = await this.fetchLink(linkID)
    if (link.Type === 2) throw new Error("cannot stream a directory")

    const nodeKR = await this.getLinkKR(linkID)
    const contentKeyPacket = link.FileProperties?.ContentKeyPacket
    if (!contentKeyPacket) {
      throw new Error("file has no content key packet")
    }

    // 解密 content session key
    const sessionKey = await decryptSessionKeyPacket(contentKeyPacket, nodeKR)

    // 獲取 revision（含加密分塊列表）
    const revisions = (await this.client.requestAPI(
      `/drive/volumes/${this.getVolumeID()}/links/${linkID}/revisions`,
    )) as { Code: number; Revisions: any[] }
    const revision = revisions.Revisions?.find((r) => r.State === 1) || revisions.Revisions?.[0]
    if (!revision?.Blocks?.length) {
      throw new Error("file has no blocks")
    }
    const blocks = revision.Blocks as {
      Index: number
      BareURL: string
      Token: string
    }[]

    // 解密後真實大小（用於無 Range 請求時的 end 計算）
    const decryptedSize =
      (await decryptXAttrSize(link.XAttr || "", nodeKR)) || revision.Size || 0
    const chunkSize = (parseInt(this.addition.chunk_size || "4") || 4) * 1024 * 1024

    const start = options?.start ?? 0
    // 當解密後大小未知時（decryptedSize <= 0），使用一個足夠大的上界，
    // 避免無 Range 的完整下載只流式傳輸第一個字節。
    const end =
      options?.end ?? (decryptedSize > 0 ? decryptedSize - 1 : Number.MAX_SAFE_INTEGER)

    let self = this
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          let position = start
          for (const block of blocks) {
            if (position > end) break
            const blockBytes = await self.downloadBlock(block.BareURL, block.Token)
            const plain = await decryptBinaryWithSessionKey(blockBytes, [sessionKey])

            // 按字節區間切片
            const blockStart = block.Index * chunkSize
            const blockEnd = blockStart + plain.length - 1
            const from = Math.max(start, blockStart)
            const to = Math.min(end, blockEnd)
            if (from <= to) {
              controller.enqueue(plain.slice(from - blockStart, to - blockStart + 1))
              position = to + 1
            }
          }
          controller.close()
        } catch (e: any) {
          controller.error(e)
        }
      },
    })
  }

  private async downloadBlock(bareURL: string, token: string): Promise<Uint8Array> {
    const res = await fetch(bareURL, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) {
      throw new Error(`block download failed: ${res.status}`)
    }
    return new Uint8Array(await res.arrayBuffer())
  }

  // ---------- write operations ----------

  async mkdir(virtualPath: string, physicalPath: string): Promise<void> {
    const clean = this.cleanPath(physicalPath)
    const parentPath = clean.split("/").slice(0, -1).join("/") || "/"
    const dirName = clean.split("/").pop() || ""
    const parentId = await this.resolveId(parentPath)

    const parentKR = await this.getLinkKR(parentId)
    const encryptedName = await encryptText(dirName, parentKR)
    const nameHash = await getNameHash(dirName)

    // 生成節點密鑰對（公鑰作為 NodeKey 上傳，私鑰的 passphrase 用父密鑰環加密）
    const { publicKey: nodePublicArmored } = await openpgp.generateKey({
      type: "ecc",
      curve: "curve25519Legacy",
      userIDs: [{ name: dirName, email: this.mainShare?.Creator || "" }],
    })
    const nodePassphrase = randomPassphrase()
    const encryptedPassphrase = await encryptText(nodePassphrase, parentKR)

    await this.client.requestAPI("/drive/shares/" + this.getShareID() + "/folders", {
      method: "POST",
      body: {
        ParentLinkID: parentId,
        Name: encryptedName,
        Hash: nameHash,
        NodeKey: nodePublicArmored,
        NodePassphrase: encryptedPassphrase,
        NodePassphraseSignature: "",
        SignatureAddress: this.defaultAddrID,
        NameSignatureEmail: this.mainShare?.Creator || "",
      },
    })
  }

  async rename(
    virtualPath: string,
    physicalPath: string,
    newName: string,
  ): Promise<void> {
    const linkID = await this.resolveId(physicalPath)
    const link = await this.fetchLink(linkID)
    const parentKR = await this.getLinkKR(link.ParentLinkID)

    const encryptedName = await encryptText(newName, parentKR)
    const newHash = await getNameHash(newName)
    const originalHash = link.Hash || ""

    await this.client.requestAPI(
      `/drive/volumes/${this.getVolumeID()}/links/${linkID}/rename`,
      {
        method: "PUT",
        body: {
          Name: encryptedName,
          NameSignatureEmail: this.mainShare?.Creator || "",
          Hash: newHash,
          OriginalHash: originalHash,
        },
      },
    )
  }

  async remove(
    virtualPath: string,
    physicalPath: string,
    names: string[],
  ): Promise<void> {
    const linkID = await this.resolveId(physicalPath)
    await this.client.requestAPI(
      `/drive/volumes/${this.getVolumeID()}/links/${linkID}/trash`,
      { method: "POST" },
    )
  }

  async move(
    srcDir: string,
    dstDir: string,
    names: string[],
    srcPhys: string,
    dstPhys: string,
  ): Promise<void> {
    // TODO(未實現)：Proton Drive 移動文件並非簡單的 parentLinkID 變更，而是
    // 必須把源節點的 NodePassphrase 用「目標父節點的密鑰環」重新加密後上傳，
    // 否則目標父節點無法解開子節點密鑰鏈。實現路徑：
    //   1) 用 srcLink 的父密鑰環解密 NodePassphrase 得到明文 passphrase
    //   2) 用 dstLink 的密鑰環(await getLinkKR(dstId))重新 encryptText 該 passphrase
    //   3) 調用 /drive/volumes/{vol}/links/{linkId}/move 提交 ParentLinkID + 新 NodePassphrase
    // 由於涉及密鑰鏈交叉重加密與原子性，本移植版本暫未實現。
    throw new Error("ProtonDrive move is not supported yet")
  }

  async copy(
    srcDir: string,
    dstDir: string,
    names: string[],
    srcPhys: string,
    dstPhys: string,
  ): Promise<void> {
    // TODO(未實現)：複製等價於「新建節點 + 複用源文件的 content session key」。
    // 需要對源節點的 NodeKey/NodePassphrase 與文件 ContentKeyPacket 在目標父
    // 密鑰環下重建，且要處理跨 share 的場景，複雜度高於 move，暫未實現。
    throw new Error("ProtonDrive copy is not supported")
  }

  async put(
    virtualPath: string,
    physicalPath: string,
    content: Buffer,
  ): Promise<void> {
    // TODO(未實現)：上傳需走 Proton 的兩階段協議：
    //   1) POST /drive/volumes/{vol}/links/{parent}/draft 創建草稿，得到 revisionID
    //   2) 每個 4MB 分塊用獨立隨機 session key 做 AEAD 加密，POST 到 block 上傳端點
    //   3) 彙總 block 元資料後提交 revision，並把文件 ContentKeyPacket 用節點密鑰環加密
    // 且分塊必須流式處理以控制記憶體。本移植版本暫未實現。
    throw new Error("ProtonDrive upload is not supported yet")
  }
}

function randomPassphrase(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return btoa(String.fromCharCode(...bytes))
}
