import axios from 'axios';
import crypto from 'crypto';
import fs from 'fs';
import { ClientRequest } from 'http';
import { Socket } from 'net';
import DataStreamy from '../../../commonInterface/util/DataStreamy';
import { sleepMsec } from '../../../commonInterface/util/util';
import { byteCount, ByteCount, byteCountToNumber, ChannelName, elapsedSince, FileKey, FileManifest, FileManifestChunk, isBuffer, isNull, isNumber, isOneOf, isString, localFilePath, LocalFilePath, NodeId, nowTimestamp, scaledDurationMsec, Sha1Hash, UrlString, _validateObject } from '../../../commonInterface/kacheryTypes';
import randomAlphaString from '../../../commonInterface/util/randomAlphaString';
import NodeStats from '../../../kacheryInterface/core/NodeStats';
import logger from "winston";;

type LinkObject = {
    path: string,
    manifestSha1: string | null,
    stat: {
        size: number,
        mtime: number
    },
    _writingProcess?: string
}

const isLinkObjectStat = (x: any) => {
    return _validateObject(x, {
        size: isNumber,
        mtime: isNumber
    }, {allowAdditionalFields: true})
}

const isLinkObject = (x: any): x is LinkObject => {
    return _validateObject(x, {
        path: isString,
        manifestSha1: isOneOf([isString, isNull]),
        stat: isLinkObjectStat
    }, {allowAdditionalFields: true})
}

export class KacheryStorageManager {
    #storageDir: LocalFilePath
    #onFileStoredCallbacks: ((sha1: Sha1Hash) => void)[] = []
    constructor(storageDir: LocalFilePath) {
        if (!fs.existsSync(storageDir.toString())) {
            throw Error(`Kachery storage directory does not exist: ${storageDir}`)
        }
        this.#storageDir = storageDir
    }
    async findFile(fileKey: FileKey): Promise<{ found: boolean, size: ByteCount, localFilePath: LocalFilePath | null }> {
        if (fileKey.sha1) {
            const { path: filePath, size: fileSize } = await this._getLocalFileInfo(fileKey.sha1);
            if ((filePath) && (fileSize !== null)) {
                return { found: true, size: fileSize, localFilePath: filePath }
            }
        }
        if (fileKey.chunkOf) {
            const { path: filePath, size: fileSize } = await this._getLocalFileInfo(fileKey.chunkOf.fileKey.sha1)
            if (filePath) {
                const offset = fileKey.chunkOf.startByte
                const size = byteCount(byteCountToNumber(fileKey.chunkOf.endByte) - byteCountToNumber(fileKey.chunkOf.startByte))
                return { found: true, size, localFilePath: null } // in this case it's not the entire file, so we are not going to return the local file path
            }
        }
        return { found: false, size: byteCount(0), localFilePath: null }
    }
    async storeFile(sha1: Sha1Hash, data: Buffer) {
        const s = sha1;
        const destParentPath = `${this.#storageDir}/sha1/${s[0]}${s[1]}/${s[2]}${s[3]}/${s[4]}${s[5]}`
        const destPath = `${destParentPath}/${s}`
        if (fs.existsSync(destPath)) {
            return
        }
        fs.mkdirSync(destParentPath, {recursive: true});
        const destPathTmp = `${destPath}.${randomAlphaString(5)}.tmp`
        await fs.promises.writeFile(destPathTmp, data)
        if (fs.existsSync(destPath)) {
            /* istanbul ignore next */
            {
                fs.unlinkSync(destPathTmp)
                return
            }
        }
        await renameAndCheck(destPathTmp, destPath, data.length)
        this._reportFileStored(sha1)
    }
    async storeFileFromStream(ds: DataStreamy, fileSize: ByteCount, o: {calculateHashOnly: boolean}): Promise<{sha1: Sha1Hash, manifestSha1: Sha1Hash | null}> {
        const tmpDestPath = !o.calculateHashOnly ? `${this.#storageDir}/store.file.${randomAlphaString(10)}.tmp` : null
        const writeStream = tmpDestPath ? fs.createWriteStream(tmpDestPath) : null
        const shasum = crypto.createHash('sha1')
        const manifestChunks: FileManifestChunk[] = []
        const manifestData: {
            buffers: Buffer[],
            byte1: number,
            byte2: number
        } = {buffers: [], byte1: 0, byte2: 0}
        let complete = false
        const chunkSize = 20 * 1000 * 1000
        const _updateManifestChunks = ({final}: {final: boolean}) => {
            if ((manifestData.byte2 - manifestData.byte1 >= chunkSize) || ((final) && (manifestData.byte2 > manifestData.byte1))) {
                const d = Buffer.concat(manifestData.buffers)
                manifestData.buffers = []
                for (let i = 0; i < d.length; i+=chunkSize) {
                    const x = d.slice(i, i + Math.min(chunkSize, d.length - i))
                    if ((x.length === chunkSize) || (final)) {
                        manifestChunks.push({
                            start: byteCount(manifestData.byte1),
                            end: byteCount(manifestData.byte1 + x.length),
                            sha1: computeSha1OfBufferSync(x) // note that this is synchronous (not ideal)
                        })
                        manifestData.byte1 += x.length
                    }
                    else {
                        manifestData.buffers.push(x)
                    }
                }
            }
        }
        return new Promise((resolve, reject) => {
            const _cleanup = () => {
                try {
                    if (tmpDestPath) fs.unlinkSync(tmpDestPath)
                }
                catch(e) {
                }
            }
            ds.onData(buf => {
                if (complete) return
                shasum.update(buf)
                if (writeStream) writeStream.write(buf)
                manifestData.buffers.push(buf)
                manifestData.byte2 += buf.length
                _updateManifestChunks({final: false})
            })
            ds.onError(err => {
                if (complete) return
                complete = true
                _cleanup()
                reject(err)
            })
            ds.onFinished(() => {
                if (complete) return
                complete = true
                try {
                    const sha1Computed = shasum.digest('hex') as any as Sha1Hash
                    const s = sha1Computed
                    const destParentPath = `${this.#storageDir}/sha1/${s[0]}${s[1]}/${s[2]}${s[3]}/${s[4]}${s[5]}`
                    const destPath = `${destParentPath}/${s}`
                    const nextStep = () => {
                        _updateManifestChunks({final: true})
                        const manifest: FileManifest = {
                            size: byteCount(manifestData.byte2),
                            sha1: sha1Computed,
                            chunks: manifestChunks
                        }
                        let manifestSha1: Sha1Hash | null = null
                        if (manifestChunks.length > 1) {
                            const manifestJson = Buffer.from(JSON.stringify(manifest), 'utf-8')
                            manifestSha1 = computeSha1OfBufferSync(manifestJson)
                            this.storeFile(manifestSha1, manifestJson)
                        }
                        _cleanup()
                        resolve({sha1: sha1Computed, manifestSha1})
                        this._reportFileStored(sha1Computed)
                    }
                    if ((!o.calculateHashOnly) && (tmpDestPath)) {
                        if (fs.existsSync(destPath)) {
                            // if the dest path already exists, we already have the file and we are good
                            nextStep()
                        }
                        else {
                            // dest path does not already exist
                            fs.mkdirSync(destParentPath, {recursive: true});
                            renameAndCheck(tmpDestPath, destPath, byteCountToNumber(fileSize)).then(nextStep).catch(err3 => {
                                _cleanup()
                                reject(err3)
                            })
                        }
                    }
                    else {
                        nextStep()
                    }
                }
                catch(err2) {
                    _cleanup()
                    reject(err2)
                }
            })
        })
    }
    async storeFileFromBucketUrl(url: UrlString, o: {sha1: Sha1Hash, nodeStats: NodeStats, channelName: ChannelName}): Promise<DataStreamy> {
        const tmpDestPath = `${this.#storageDir}/store.file.${randomAlphaString(10)}.tmp`
        const writeStream = fs.createWriteStream(tmpDestPath)
        const shasum = crypto.createHash('sha1')

        const res = await axios.get(url.toString(), {responseType: 'stream'})
        const stream = res.data
        const socket: Socket = stream.socket
        const req: ClientRequest = stream.req
        const contentLength: number | string = res.headers['Content-Length'] || res.headers['content-length']
        const size: ByteCount = byteCount(typeof(contentLength) === 'string' ? parseInt(contentLength) : contentLength)
        const ret = new DataStreamy()
        let complete = false

        const _cleanup = () => {
            try {
                fs.unlinkSync(tmpDestPath)
            }
            catch(e) {
            }
        }

        const _reportError = (err: Error) => {
            _cleanup()
            ret.producer().error(err)
        }

        const _reportDone = () => {
            _cleanup()
            ret.producer().end()
            this._reportFileStored(o.sha1)
        }

        ret.producer().start(size)
        ret.producer().onCancelled(() => {
            if (complete) return
            // todo: is this the right way to close it?
            req.destroy()
        })
        stream.on('data', (data: Buffer) => {
            o.nodeStats.reportBytesReceived(byteCount(data.length), o.channelName)
            if (complete) return
            shasum.update(data)
            writeStream.write(data)
            ret.producer().incrementBytes(byteCount(data.length))
        })
        stream.on('error', (err: Error) => {
            if (complete) return
            complete = true
            _reportError(err)
        })
        stream.on('end', () => {
            if (complete) return
            complete = true
            try {
                const sha1Computed = shasum.digest('hex') as any as Sha1Hash
                const s = sha1Computed
                if (s !== o.sha1) {
                    _reportError(new Error(`Unexpected SHA1 hash of downloaded file: ${url} ${s} <> ${o.sha1}`))
                    return
                }
                const destParentPath = `${this.#storageDir}/sha1/${s[0]}${s[1]}/${s[2]}${s[3]}/${s[4]}${s[5]}`
                const destPath = `${destParentPath}/${s}`
                if (fs.existsSync(destPath)) {
                    // if the dest path already exists, we already have the file and we are good
                    _reportDone()
                }
                else {
                    // dest path does not already exist
                    fs.mkdirSync(destParentPath, {recursive: true});
                    renameAndCheck(tmpDestPath, destPath, byteCountToNumber(size)).then(_reportDone).catch((err3) => {
                        _reportError(err3)
                    })
                }
            }
            catch(err2) {
                _reportError(err2)
            }
        })
        socket.on('close', () => {
            if (complete) return
            complete = true
            _reportError(new Error('Socket closed.'))
        })

        return ret
    }
    async storeLocalFile(localFilePath: LocalFilePath): Promise<{sha1: Sha1Hash, manifestSha1: Sha1Hash | null}> {
        let stat0: fs.Stats
        try {
            stat0 = await fs.promises.stat(localFilePath.toString())
        }
        catch (err) {
            throw Error(`Unable to stat file. Perhaps the kachery daemon does not have permission to read this file: ${localFilePath}`)
        }
        const fileSize = byteCount(stat0.size)
        const ds = createDataStreamyForFile(localFilePath, byteCount(0), fileSize)
        return await this.storeFileFromStream(ds, fileSize, {calculateHashOnly: false})
    }
    async linkLocalFile(localFilePath: LocalFilePath, o: {size: number, mtime: number}): Promise<{sha1: Sha1Hash, manifestSha1: Sha1Hash | null}> {
        let stat0: fs.Stats
        try {
            stat0 = await fs.promises.stat(localFilePath.toString())
        }
        catch (err) {
            throw Error(`Unable to stat file. Perhaps the kachery daemon does not have permission to read this file: ${localFilePath}`)
        }
        const fileSize = byteCount(stat0.size)
        if (byteCountToNumber(fileSize) !== o.size) {
            throw Error(`Mismatch of file size in linkLocalFile: ${localFilePath} ${fileSize} <> ${o.size}`)
        }
        const mtime = Number(stat0.mtime) / 1000 // in seconds
        if (Math.abs(mtime - o.mtime) > 0.002) { // allow tolerance because python gives mtime with greater precision
            throw Error(`Mismatch of file mtime in linkLocalFile: ${localFilePath} ${mtime} <> ${o.mtime}`)
        }
        const ds = createDataStreamyForFile(localFilePath, byteCount(0), fileSize)
        const {sha1, manifestSha1} = await this.storeFileFromStream(ds, fileSize, {calculateHashOnly: true})
        const s = sha1
        const destParentPath = `${this.#storageDir}/sha1/${s[0]}${s[1]}/${s[2]}${s[3]}/${s[4]}${s[5]}`
        if (!fs.existsSync(destParentPath)) {
            fs.mkdirSync(destParentPath, {recursive: true})
        }
        const destPath = `${destParentPath}/${s}`
        if (!fs.existsSync(destPath)) {
            const x: LinkObject = {
                path: localFilePath.toString(),
                manifestSha1: manifestSha1 ? manifestSha1.toString() : null,
                stat: {
                    size: o.size,
                    mtime: o.mtime
                },
                _writingProcess: 'daemon'
            }    
            const tmpPath = destPath + '.link.' + randomAlphaString(8)
            await fs.promises.writeFile(tmpPath, JSON.stringify(x))
            fs.renameSync(tmpPath, destPath + '.link')
        }
        return {sha1, manifestSha1}
    }
    async concatenateChunksAndStoreResult(sha1: Sha1Hash, chunkSha1s: Sha1Hash[]): Promise<void> {
        const s = sha1
        const destParentPath = `${this.#storageDir}/sha1/${s[0]}${s[1]}/${s[2]}${s[3]}/${s[4]}${s[5]}`
        const destPath = `${destParentPath}/${s}`
        if (fs.existsSync(destPath)) {
            // already exists
            /* istanbul ignore next */
            return
        }

        // verify we have all the files
        for (let chunkSha1 of chunkSha1s) {
            const f = await this.findFile({sha1: chunkSha1})
            if (!f.found) {
                /* istanbul ignore next */
                throw Error(`Cannot concatenate chunk. Missing chunk: ${chunkSha1}`)
            }
        }

        const tmpPath = createTemporaryFilePath({storageDir: this.#storageDir, prefix: 'kachery-daemon-concat-'})
        const writeStream = fs.createWriteStream(tmpPath)
        const shasum = crypto.createHash('sha1')
        let totalSizeBytes = 0
        for (let chunkSha1 of chunkSha1s) {
            const readStream = await this.getFileDataStreamy({sha1: chunkSha1})
            await new Promise<void>((resolve, reject) => {
                readStream.onData(buf => {
                    totalSizeBytes += buf.length
                    shasum.update(buf)
                    writeStream.write(buf)
                })
                readStream.onError(err => {
                    reject(err)
                })
                readStream.onFinished(() => {
                    resolve()
                })
            })
        }
        await new Promise<void>((resolve, reject) => {
            writeStream.end(() => {
                const sha1Computed = shasum.digest('hex') as any as Sha1Hash
                if (sha1Computed !== sha1) {
                    /* istanbul ignore next */
                    {
                        /* istanbul ignore next */
                        {
                            reject(Error('Did not get the expected SHA-1 sum for concatenated file'))
                            return
                        }
                    }
                }
                resolve()
            })
        })
        if (fs.existsSync(destPath)) {
            // already exists
            /* istanbul ignore next */
            {
                fs.unlinkSync(tmpPath)
                return
            }
        }
        fs.mkdirSync(destParentPath, {recursive: true});
        await renameAndCheck(tmpPath, destPath, totalSizeBytes)
        this._reportFileStored(sha1)
    }
    async hasLocalFile(fileKey: FileKey): Promise<boolean> {
        if (fileKey.sha1) {
            const { path: filePath, size: fileSize } = await this._getLocalFileInfo(fileKey.sha1)
            if ((filePath) && (fileSize !== null)) {
                return true
            }
        }
        if (fileKey.chunkOf) {
            const { path: filePath, size: fileSize } = await this._getLocalFileInfo(fileKey.chunkOf.fileKey.sha1)
            if (filePath) {
                return true
            }
        }
        return false
    }
    async getFileDataStreamy(fileKey: FileKey, startByte?: ByteCount, endByte?: ByteCount): Promise<DataStreamy> {
        const {stream: readStream, size} = await this.getFileReadStream(fileKey, startByte, endByte)
        return createDataStreamyFromReadStream(readStream, size)
    }
    async getFileReadStream(fileKey: FileKey, startByte?: ByteCount, endByte?: ByteCount): Promise<{stream: fs.ReadStream, size: ByteCount}> {
        if (fileKey.sha1) {
            const { path: filePath, size: fileSize } = await this._getLocalFileInfo(fileKey.sha1)
            if ((filePath) && (fileSize !== null)) {
                const offset = (startByte === undefined) || (endByte === undefined) ? byteCount(0) : startByte
                const size = (startByte === undefined) || (endByte === undefined) ? fileSize : byteCount(byteCountToNumber(endByte) - byteCountToNumber(startByte))
                return {stream: createReadStreamForFile(filePath, offset, size), size}
            }
        }
        if (fileKey.chunkOf) {
            const { path: filePath, size: fileSize } = await this._getLocalFileInfo(fileKey.chunkOf.fileKey.sha1)
            if (filePath) {
                const additionalOffset = (startByte === undefined) || (endByte === undefined) ? byteCount(0) : startByte
                const offset = byteCount(byteCountToNumber(fileKey.chunkOf.startByte) + byteCountToNumber(additionalOffset))
                const size = (startByte === undefined) || (endByte === undefined) ? byteCount(byteCountToNumber(fileKey.chunkOf.endByte) - byteCountToNumber(fileKey.chunkOf.startByte)) : byteCount(byteCountToNumber(endByte) - byteCountToNumber(startByte))
                return {stream: createReadStreamForFile(filePath, offset, size), size}
            }
        }
        throw Error('Unable get data read stream for local file.')
    }
    async moveFileToTrash(sha1: Sha1Hash) {
        const info = await this._getLocalFileInfo(sha1)
        if (!info.path) return
        const s = sha1
        const destParentPath = `${this.#storageDir}/sha1-trash/${s[0]}${s[1]}/${s[2]}${s[3]}/${s[4]}${s[5]}`
        const destPath = `${destParentPath}/${s}`
        if (fs.existsSync(destPath)) {
            await fs.promises.unlink(info.path.toString())
            return
        }
        if (!fs.existsSync(destParentPath)) {
            fs.mkdirSync(destParentPath, {recursive: true});
        }
        await fs.promises.rename(info.path.toString(), destPath)
    }
    onFileStored(callback: (sha1: Sha1Hash) => void) {
        this.#onFileStoredCallbacks.push(callback)
    }
    _reportFileStored(sha1: Sha1Hash) {
        this.#onFileStoredCallbacks.forEach(cb => cb(sha1))
    }
    async _getLocalFileInfo(fileSha1: Sha1Hash): Promise<{ path: LocalFilePath | null, size: ByteCount | null }> {
        // first check for regular file (not linked)
        const {path: path1, size: size1} = await this._getLocalFileInfo1(fileSha1)
        if (path1) return {path: path1, size: size1}
        // then check for linked file
        const {path: path2, size: size2} = await this._getLocalFileInfo2(fileSha1)
        if (path2) return {path: path2, size: size2}
        // we didn't find it
        return {path: null, size: null}
    }
    async _getLocalFileInfo1(fileSha1: Sha1Hash): Promise<{ path: LocalFilePath | null, size: ByteCount | null }> {
        // check for regular file (not linked)
        const s = fileSha1;
        const path = localFilePath(`${this.#storageDir}/sha1/${s[0]}${s[1]}/${s[2]}${s[3]}/${s[4]}${s[5]}/${s}`)
        let stat0: fs.Stats
        try {
            stat0 = await fs.promises.stat(path.toString())
        }
        catch (err) {
            return { path: null, size: null }
        }
        return {
            path,
            size: byteCount(stat0.size)
        }
    }
    async _getLocalFileInfo2(fileSha1: Sha1Hash): Promise<{ path: LocalFilePath | null, size: ByteCount | null }> {
        // check for linked file
        const s = fileSha1;
        const linkPath = localFilePath(`${this.#storageDir}/sha1/${s[0]}${s[1]}/${s[2]}${s[3]}/${s[4]}${s[5]}/${s}.link`)
        if (fs.existsSync(linkPath.toString())) {
            const x = await readJsonFile(linkPath.toString())
            if (!x) return {path: null, size: null}
            if (!isLinkObject(x)) {
                logger.warn(`Unexpected. Not a link object: ${linkPath}`)
                return {path: null, size: null}
            }
            const path = x.path
            let stat0: fs.Stats
            try {
                stat0 = await fs.promises.stat(path.toString())
            }
            catch (err) {
                return { path: null, size: null }
            }
            return {
                path: path as any as LocalFilePath,
                size: byteCount(stat0.size)
            }
        }
        else {
            return {path: null, size: null}
        }
    }
    storageDir() {
        return this.#storageDir
    }
}

const computeSha1OfBufferSync = (buf: Buffer) => {
    const shasum = crypto.createHash('sha1')
    shasum.update(buf)
    return shasum.digest('hex') as any as Sha1Hash
}

const createReadStreamForFile = (path: LocalFilePath, offset: ByteCount, size: ByteCount): fs.ReadStream => {
    // note.. for some reason if we put {encoding: 'binary'} we get text data chunks
    const readStream = fs.createReadStream(path.toString(), { start: byteCountToNumber(offset), end: byteCountToNumber(offset) + byteCountToNumber(size) - 1 })
    return readStream
}

const createDataStreamyFromReadStream = (readStream: fs.ReadStream, size: ByteCount) => {
    const ret = new DataStreamy()
    ret.producer().start(size)
    readStream.on('data', (chunk: any) => {
        if (!isBuffer(chunk)) {
            throw Error('Unexpected type of data chunk')
        }
        ret.producer().data(chunk)
    })
    readStream.on('end', () => {
        ret.producer().end()
    })
    readStream.on('error', (err: Error) => {
        ret.producer().error(err)
    })
    ret.producer().onCancelled(() => {
        readStream.close()
    })
    return ret
}

const createDataStreamyForFile = (path: LocalFilePath, offset: ByteCount, size: ByteCount) => {
    const readStream = createReadStreamForFile(path, offset, size)
    return createDataStreamyFromReadStream(readStream, size)
}

export const createTemporaryFilePath = (args: {storageDir: LocalFilePath, prefix: string}) => {
    const dirPath = args.storageDir + '/tmp'
    fs.mkdirSync(dirPath, {recursive: true})
    return `${dirPath}/${args.prefix}-${randomAlphaString(10)}`
}

export const renameAndCheck = async (srcPath: string, dstPath: string, expectedSizeBytes: number) => {
    try {
        // this line occassionaly fails on our ceph system and it is unclear the reason. So I am catching the error to troubleshoot
        fs.renameSync(srcPath, dstPath)
    }
    catch(err) {
        if (!fs.existsSync(dstPath)) {
            throw Error(`Unexpected problem renaming file. File does not exist: ${dstPath}: ${err.message}`)
        }
        throw Error(`Unexpected problem renaming file. Even though file exists: ${dstPath}: ${err.message}`)
    }
    // we need to stat the file here for purpose of flushing to disk (problem encountered on franklab system)
    const timeoutMsec = 1000 * 10
    const timer = nowTimestamp()
    while (true) {
        const size0 = fs.statSync(dstPath).size
        if (size0 === expectedSizeBytes) break // we are good
        await sleepMsec(scaledDurationMsec(100))
        const elapsed = elapsedSince(timer)
        if (elapsed > timeoutMsec) {
            throw Error(`Unexpected: file does not have expected size after renaming (*): ${dstPath} ${size0} ${expectedSizeBytes}`)
        }
    }
    fs.chmodSync(dstPath, fs.constants.S_IRUSR | fs.constants.S_IWUSR | fs.constants.S_IRGRP | fs.constants.S_IROTH)
}

const readJsonFile = async (path: string): Promise<Object | null> => {
    try {
        const txt = await fs.promises.readFile(path, 'utf-8') as string;
        return JSON.parse(txt);
    }
    catch(err) {
        return null
    }
}