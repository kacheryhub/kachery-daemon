import DataStreamy, { DataStreamyProgress } from '../../commonInterface/util/DataStreamy'
import { formatByteCount, sha1MatchesFileKey } from '../../commonInterface/util/util'
import KacheryNode from './KacheryNode'
import { byteCount, ByteCount, byteCountToNumber, ChannelName, elapsedSince, FileKey, FileManifestChunk, isFileManifest, LocalFilePath, nowTimestamp, Sha1Hash, UrlString } from '../../commonInterface/kacheryTypes'
import logger from "winston";


export const loadFileAsync = async (node: KacheryNode, fileKey: FileKey, opts: {channelName?: ChannelName, label: string}): Promise<{found: boolean, size: ByteCount, localFilePath: LocalFilePath | null}> => {
    const r = await node.kacheryStorageManager().findFile(fileKey)
    if (r.found) {
        return r
    }
    const ds = await loadFile(node, fileKey, opts)
    return await new Promise<{found: boolean, size: ByteCount, localFilePath: LocalFilePath | null}>((resolve, reject) => {
        ds.onError(err => {
            reject(err)
        })
        ds.onFinished(() => {
            node.kacheryStorageManager().findFile(fileKey).then((r) => {
                if (r.found) {
                    resolve(r)
                }
                else {
                    reject(Error('Unexpected - unable to findFile after loadFile reported finished.'))
                }
            }, (err: Error) => {
                reject(err)
            })
        })
    })
}

async function asyncLoop<T>(list: T[], func: (item: T, index: number) => Promise<void>, opts: {numSimultaneous: number}) {
    return new Promise<void>((resolve, reject) => {
        let i = 0
        let numComplete = 0
        let numRunning = 0
        let error = false
        const update = () => {
            if (error) return
            if (numComplete === list.length) {
                resolve()
                return
            }
            if (numRunning < opts.numSimultaneous) {
                if (i < list.length) {
                    i ++
                    numRunning ++
                    func(list[i - 1], i - 1).then(() => {
                        numComplete ++
                        numRunning --
                        process.nextTick(update)
                    })
                    .catch((err: Error) => {
                        error = true
                        numRunning --
                        reject(err)
                    })
                    update()
                }
            }
        }
        update()
    })
}

// old system did not include channelName, with new system it is mandatory
export const loadFile = async (node: KacheryNode, fileKey: FileKey, opts: {channelName?: ChannelName, label: string, _numRetries?: number}): Promise<DataStreamy> => {
    const r = await node.kacheryStorageManager().findFile(fileKey)
    if (r.found) {
        if (true) { // for debugging (not finding locally) switch to false
            const ret = new DataStreamy()
            ret.producer().end()
            return ret
        }
    }

    const loadFileWithManifest = async () => {
        const manifestSha1 = fileKey.manifestSha1
        if (!manifestSha1) throw Error('Unexpected')
        const entireFileTimestamp = nowTimestamp()
        const ret = new DataStreamy()
        const manifestFileKey = {sha1: manifestSha1}
        let manifestR
        try {
            manifestR = await loadFileAsync(node, manifestFileKey, {channelName: opts.channelName, label: `${opts.label} manifest`})
        }
        catch(err: any) {
            logger.warn(`Manifest not found: ${manifestSha1}`)
            ret.producer().error(err)
            return ret
        }
        if (!manifestR.found) {
            throw Error('Unexpected... loadFileAsync should have thrown an error if not found')
        }
        const manifestDataStream = await node.kacheryStorageManager().getFileDataStreamy(manifestFileKey)
        const manifestJson = (await manifestDataStream.allData()).toString()
        const manifest = JSON.parse(manifestJson)
        if (!isFileManifest(manifest)) {
            ret.producer().error(Error('Invalid manifest file'))
            return ret
        }
        if (!sha1MatchesFileKey({sha1: manifest.sha1, fileKey})) {
            ret.producer().error(Error(`Manifest sha1 does not match file key: ${manifest.sha1}`))
            return ret
        }
        let chunkDataStreams: DataStreamy[] = []
        const _calculateTotalBytesLoaded = () => {
            let bytesLoaded = 0
            chunkDataStreams.forEach(ds => {
                bytesLoaded += byteCountToNumber(ds.bytesLoaded())
            })
            return byteCount(bytesLoaded)
        }
        const _updateProgressForManifestLoad = () => {
            // this can be made more efficient - don't need to loop through all in-progress files every time
            const bytesLoaded = _calculateTotalBytesLoaded()
            ret.producer().reportBytesLoaded(bytesLoaded)
        }
        const _concatenateChunks = async () => {
            const chunkSha1s: Sha1Hash[] = manifest.chunks.map(c => c.sha1)
            await node.kacheryStorageManager().concatenateChunksAndStoreResult(manifest.sha1, chunkSha1s)
            ret.producer().end()
        }
        const _cancelAllChunkDataStreams = () => {
            chunkDataStreams.forEach((ds) => {
                ds.cancel()
            })
            chunkDataStreams = [] // do this so we don't cancel things twice (although it would not be a big deal)
        }
        ret.onError(() => {
            // this will get called if ret is cancelled or if there is another error
            _cancelAllChunkDataStreams()
        })
        ;(async () => {
            let timer = nowTimestamp()
            // this happens after ret is returned
            ret.producer().start(manifest.size)
            let numComplete = 0
            let errored = false
            try {
                await asyncLoop<FileManifestChunk>(manifest.chunks, async (chunk: FileManifestChunk, chunkIndex: number) => {
                    if (errored) return
                    const chunkFileKey: FileKey = {
                        sha1: chunk.sha1,
                        chunkOf: {
                            fileKey: {
                                sha1: manifest.sha1
                            },
                            startByte: chunk.start,
                            endByte: chunk.end
                        }
                    }
                    logger.info(`${opts.label}: Handling chunk ${chunkIndex} of ${manifest.chunks.length}`)
                    const label0 = `${opts.label} ch ${chunkIndex}`
                    const ds = await loadFile(node, chunkFileKey, {channelName: opts.channelName, label: label0, _numRetries: 2})
                    chunkDataStreams.push(ds)
                    return new Promise<void>((resolve, reject) => {
                        ds.onError(err => {
                            errored = true
                            reject(err)
                        })
                        ds.onProgress((progress: DataStreamyProgress) => {
                            _updateProgressForManifestLoad()
                        })
                        ds.onFinished(() => {
                            numComplete ++
                            if (numComplete === manifest.chunks.length) {
                                logger.info(`${opts.label}: Concatenating chunks`)
                                _concatenateChunks().then(() => {
                                    const bytesLoaded = _calculateTotalBytesLoaded()
                                    const elapsedSec = elapsedSince(entireFileTimestamp) / 1000
                                    const rate = (byteCountToNumber(bytesLoaded) / 1e6) / elapsedSec
                                    logger.info(`${opts.label}: Downloaded ${formatByteCount(bytesLoaded)} in ${elapsedSec} sec [${rate.toFixed(3)} MiB/sec]`)
                                    ret.producer().end()
                                }).catch((err: Error) => {
                                    reject(err)
                                })
                            }
                            resolve()
                        })
                    })
                }, {numSimultaneous: 5})
            }
            catch(err: any) {
                ret.producer().error(err)
                return
            }
        })()
        return ret
    }
    const loadFileWithoutManifest = async (): Promise<DataStreamy> => {
        if (!opts.channelName) {
            const ret = new DataStreamy()
            ret.producer().error(new Error('Unable to find file. No channelName specified.'))
            return ret    
        }
        let timer = nowTimestamp()
        for (let pass = 1; pass <= 2; pass++) {
            const resultUrl = await node.kacheryHubInterface().checkForFileInChannelBucket(fileKey.sha1, opts.channelName)
            if (resultUrl) {
                return await node.kacheryStorageManager().storeFileFromBucketUrl(resultUrl, {sha1: fileKey.sha1, nodeStats: node.stats(), channelName: opts.channelName})
            }
            if (pass === 1) {
                const success = await node.kacheryHubInterface().requestFileFromChannel(fileKey, opts.channelName)
                if (!success) break
            }
        }
        const ret = new DataStreamy()
        ret.producer().error(new Error('Unable to find file'))
        return ret
    }

    if (fileKey.manifestSha1) {
        return await loadFileWithManifest()
    }
    else {
        return await loadFileWithoutManifest()
    }
}