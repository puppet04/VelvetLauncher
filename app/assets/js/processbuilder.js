const AdmZip                = require('adm-zip')
const child_process         = require('child_process')
const crypto                = require('crypto')
const fs                    = require('fs-extra')
const { LoggerUtil }        = require('helios-core')
const { getMojangOS, isLibraryCompatible, mcVersionAtLeast }  = require('helios-core/common')
const { Type }              = require('helios-distribution-types')
const os                    = require('os')
const path                  = require('path')

const ConfigManager            = require('./configmanager')

const logger = LoggerUtil.getLogger('ProcessBuilder')


/**
 * Only forge and fabric are top level mod loaders.
 * 
 * Forge 1.13+ launch logic is similar to fabrics, for now using usingFabricLoader flag to
 * change minor details when needed.
 * 
 * Rewrite of this module may be needed in the future.
 */
class ProcessBuilder {

    constructor(distroServer, vanillaManifest, modManifest, authUser, launcherVersion){
        this.gameDir = path.join(ConfigManager.getInstanceDirectory(), distroServer.rawServer.id)
        this.commonDir = ConfigManager.getCommonDirectory()
        this.server = distroServer
        this.vanillaManifest = vanillaManifest
        this.modManifest = modManifest
        this.authUser = authUser
        this.launcherVersion = launcherVersion
        this.forgeModListFile = path.join(this.gameDir, 'forgeMods.list') // 1.13+
        this.fmlDir = path.join(this.gameDir, 'forgeModList.json')
        this.llDir = path.join(this.gameDir, 'liteloaderModList.json')
        this.libPath = path.join(this.commonDir, 'libraries')

        this.usingLiteLoader = false
        this.usingFabricLoader = false
        this.llPath = null
    }
    
    /**
     * Convienence method to run the functions typically used to build a process.
     */
    build(){
        // Ensure forge universal jar exists
        try {
            const fsSync = require('fs-extra');
            const forgeDir = path.join(this.commonDir, 'libraries', 'net', 'minecraftforge', 'forge', '1.20.1-47.4.10');
            const pJar = path.join(forgeDir, 'forge-1.20.1-47.4.10.jar');
            const uJar = path.join(forgeDir, 'forge-1.20.1-47.4.10-universal.jar');
            if (fsSync.existsSync(pJar) && !fsSync.existsSync(uJar)) {
                fsSync.copyFileSync(pJar, uJar);
            }
        } catch(e) {}
        // Ensure client-extra jar exists for Forge 1.17+ vanilla assets/lang
        try {
            const fsSync = require('fs-extra');
            const clientDir = path.join(this.commonDir, 'libraries', 'net', 'minecraft', 'client', '1.20.1-20230612.114412');
            const extraJar = path.join(clientDir, 'client-1.20.1-20230612.114412-extra.jar');
            const vId = (this.vanillaManifest && this.vanillaManifest.id) || '1.20.1';
            const vJar = path.join(this.commonDir, 'versions', vId, vId + '.jar');
            if (!fsSync.existsSync(extraJar) && fsSync.existsSync(vJar)) {
                fsSync.ensureDirSync(clientDir);
                const AdmZip = require('adm-zip');
                const srcZip = new AdmZip(vJar);
                const dstZip = new AdmZip();
                for (const entry of srcZip.getEntries()) {
                    if (!entry.entryName.endsWith('.class') && !entry.entryName.startsWith('META-INF')) {
                        dstZip.addFile(entry.entryName, entry.getData());
                    }
                }
                dstZip.writeZip(extraJar);
                logger.info('Auto-generated client-extra.jar with vanilla resources/assets');
            }
        } catch(e) {
            logger.warn('Failed to ensure client-extra jar', e);
        }
        // INJECTED: FIX DUPLICATES
        try {
            const fsSync = require('fs-extra');
            const libPath = path.join(this.commonDir, 'libraries');
            const processMods = (mods) => {
                for (const mdl of mods) {
                    if (mdl.rawModule && mdl.rawModule.type === 'Library') {
                        const mid = (mdl.rawModule && mdl.rawModule.id) || mdl.id;
                        if (!mid) continue;
                        const parts = mid.split(':');
                        if (parts.length >= 3 && parts[1].includes('_')) {
                            const group = parts[0];
                            const fakeArtifact = parts[1];
                            const version = parts[2];
                            const classifier = parts[3] || '';
                            const ext = '.jar';
                            
                            const realArtifact = fakeArtifact.split('_')[0];
                            
                            const fakeDir = path.join(libPath, group.replace(/\./g, '/'), fakeArtifact, version);
                            const fakeFile = path.join(fakeDir, fakeArtifact + '-' + version + (classifier ? '-' + classifier : '') + ext);
                            
                            const realDir = path.join(libPath, group.replace(/\./g, '/'), realArtifact, version);
                            const realFile = path.join(realDir, realArtifact + '-' + version + (classifier ? '-' + classifier : '') + ext);
                            
                            if (fsSync.existsSync(fakeFile)) {
                                fsSync.ensureDirSync(realDir);
                                fsSync.copyFileSync(fakeFile, realFile);
                            }
                        }
                    }
                    if (mdl.subModules) processMods(mdl.subModules);
                }
            };
            processMods(this.server.modules);
        } catch(e) { console.error(e); }
        // END INJECTED

        fs.ensureDirSync(this.gameDir)
        this._ensureServersDat()
        this._ensureDefaultConfigs()
        this._ensureEmotesExtracted()
        const tempNativePath = path.join(os.tmpdir(), ConfigManager.getTempNativeFolder(), crypto.pseudoRandomBytes(16).toString('hex'))
        process.throwDeprecation = true
        this.setupLiteLoader()
        logger.info('Using liteloader:', this.usingLiteLoader)
        this.usingFabricLoader = this.server.modules.some(mdl => mdl.rawModule.type === Type.Fabric)
        const modObj = this.resolveModConfiguration(ConfigManager.getModConfiguration(this.server.rawServer.id).mods, this.server.modules)
        
        // Sync optional mod files on disk (.jar <-> .jar.disabled) for modern Forge/Fabric instances
        try {
            const instanceModsDir = path.join(this.gameDir, 'mods')
            if (fs.existsSync(instanceModsDir)) {
                // Strict mod enforcement: Only mods explicitly listed in distribution.json are allowed in the mods folder
                const currentOfficialFiles = new Set()
                const collectOfficialFiles = (mdls) => {
                    for (const mdl of mdls) {
                        const raw = mdl.rawModule || {}
                        const p = raw.artifact?.path || raw.path || raw.name
                        if (p) currentOfficialFiles.add(path.basename(p).toLowerCase())
                        if (mdl.subModules && mdl.subModules.length > 0) collectOfficialFiles(mdl.subModules)
                    }
                }
                collectOfficialFiles(this.server.modules)

                const diskFiles = fs.readdirSync(instanceModsDir)
                for (const file of diskFiles) {
                    const lower = file.toLowerCase()
                    if (lower.endsWith('.jar') || lower.endsWith('.jar.disabled')) {
                        const baseJar = lower.replace(/\.disabled$/, '')
                        if (!currentOfficialFiles.has(baseJar)) {
                            try {
                                fs.removeSync(path.join(instanceModsDir, file))
                                logger.info(`Deleted unauthorized/removed mod: ${file}`)
                            } catch(e) {
                                logger.warn(`Failed to delete ${file}:`, e)
                            }
                        }
                    }
                }

                const modCfg = ConfigManager.getModConfiguration(this.server.rawServer.id).mods || {}
                const syncModuleFileState = (mdls) => {
                    for (const mdl of mdls) {
                        if (!mdl.getRequired().value) {
                            const isEnabled = ProcessBuilder.isModEnabled(modCfg[mdl.getVersionlessMavenIdentifier()], mdl.getRequired())
                            const raw = mdl.rawModule || {}
                            const artifactPath = raw.artifact?.path || raw.path || raw.name
                            if (artifactPath) {
                                const fileName = path.basename(artifactPath)
                                const jarPath = path.join(instanceModsDir, fileName)
                                const disabledPath = path.join(instanceModsDir, fileName + '.disabled')
                                if (!isEnabled) {
                                    if (fs.existsSync(jarPath)) {
                                        fs.renameSync(jarPath, disabledPath)
                                        logger.info(`Disabled optional mod on disk: ${fileName}`)
                                    } else if (!fs.existsSync(disabledPath) && fs.existsSync(mdl.getPath())) {
                                        fs.copyFileSync(mdl.getPath(), disabledPath)
                                    }
                                } else {
                                    if (fs.existsSync(disabledPath)) {
                                        fs.renameSync(disabledPath, jarPath)
                                        logger.info(`Enabled optional mod on disk: ${fileName}`)
                                    } else if (!fs.existsSync(jarPath) && fs.existsSync(mdl.getPath())) {
                                        fs.copyFileSync(mdl.getPath(), jarPath)
                                        logger.info(`Copied optional mod from modstore to disk: ${fileName}`)
                                    }
                                }
                            }
                        }
                        if (mdl.subModules && mdl.subModules.length > 0) {
                            syncModuleFileState(mdl.subModules)
                        }
                    }
                }
                syncModuleFileState(this.server.modules)
            }
        } catch(err) {
            logger.warn('Error syncing optional mod file states:', err)
        }
        
        // Mod list below 1.13
        // Fabric only supports 1.14+
        if(!mcVersionAtLeast('1.13', this.server.rawServer.minecraftVersion)){
            this.constructJSONModList('forge', modObj.fMods, true)
            if(this.usingLiteLoader){
                this.constructJSONModList('liteloader', modObj.lMods, true)
            }
        }
        
        const uberModArr = modObj.fMods.concat(modObj.lMods)
        let args = this.constructJVMArguments(uberModArr, tempNativePath)

        if(mcVersionAtLeast('1.13', this.server.rawServer.minecraftVersion)){
            //args = args.concat(this.constructModArguments(modObj.fMods))
            args = args.concat(this.constructModList(modObj.fMods))
        }

        // Hide access token
        const loggableArgs = [...args]
        loggableArgs[loggableArgs.findIndex(x => x === this.authUser.accessToken)] = '**********'

        logger.info('Launch Arguments:', loggableArgs)

        const javaExec = ConfigManager.getJavaExecutable(this.server.rawServer.id)

        // Configurar preferência de GPU dedicada (Alto Desempenho) automaticamente
        const spawnEnv = Object.assign({}, process.env)
        if (process.platform === 'win32') {
            try {
                if (javaExec) {
                    // Define no registro do Windows (DirectX UserGpuPreferences) GpuPreference=2 (Alto Desempenho / GPU Dedicada)
                    // Caso o jogador só tenha GPU integrada, o Windows utiliza a integrada normalmente sem nenhum erro.
                    child_process.spawnSync('reg.exe', [
                        'add',
                        'HKCU\\Software\\Microsoft\\DirectX\\UserGpuPreferences',
                        '/v', javaExec,
                        '/t', 'REG_SZ',
                        '/d', 'GpuPreference=2;',
                        '/f'
                    ], { stdio: 'ignore' })

                    // Também registra o executável irmão (java.exe / javaw.exe)
                    const javaDir = path.dirname(javaExec)
                    const baseName = path.basename(javaExec).toLowerCase()
                    const altName = baseName === 'javaw.exe' ? 'java.exe' : 'javaw.exe'
                    const altExec = path.join(javaDir, altName)
                    if (fs.existsSync(altExec)) {
                        child_process.spawnSync('reg.exe', [
                            'add',
                            'HKCU\\Software\\Microsoft\\DirectX\\UserGpuPreferences',
                            '/v', altExec,
                            '/t', 'REG_SZ',
                            '/d', 'GpuPreference=2;',
                            '/f'
                        ], { stdio: 'ignore' })
                    }
                }
            } catch (e) {
                logger.warn('Não foi possível definir preferência de GPU no registro:', e)
            }

            // Flags / variáveis de ambiente para drivers NVIDIA e AMD priorizarem placa dedicada
            spawnEnv.SHIM_MCCOMPAT = '0x800000001'
            spawnEnv.GPU_MAX_ALLOC_PERCENT = '100'
            spawnEnv.GPU_USE_SYNC_OBJECTS = '1'
        } else if (process.platform === 'linux') {
            // Linux PRIME offload
            spawnEnv.DRI_PRIME = '1'
            spawnEnv.__NV_PRIME_RENDER_OFFLOAD = '1'
            spawnEnv.__GLX_VENDOR_LIBRARY_NAME = 'nvidia'
            spawnEnv.__VK_LAYER_NV_optimus = 'NVIDIA_only'
        }

        const child = child_process.spawn(javaExec, args, {
            cwd: this.gameDir,
            detached: ConfigManager.getLaunchDetached(),
            env: spawnEnv
        })

        if(ConfigManager.getLaunchDetached()){
            child.unref()
        }

        child.stdout.setEncoding('utf8')
        child.stderr.setEncoding('utf8')

        child.stdout.on('data', (data) => {
            data.trim().split('\n').forEach(x => console.log(`\x1b[32m[Minecraft]\x1b[0m ${x}`))
        })
        child.stderr.on('data', (data) => {
            try { fs.appendFileSync('C:/Users/guilh/Desktop/Projeto launcher/scratch/minecraft_stderr.log', data); } catch(e){}
            data.trim().split('\n').forEach(x => console.log(`\x1b[31m[Minecraft]\x1b[0m ${x}`))
        })
        child.on('close', (code) => {
            logger.info('Exited with code', code)
            fs.remove(tempNativePath, (err) => {
                if(err){
                    logger.warn('Error while deleting temp dir', err)
                } else {
                    logger.info('Temp dir deleted successfully.')
                }
            })
        })

        return child
    }

    /**
     * Ensure servers.dat exists in the instance directory with the server IP and name,
     * so it is always present in the Multiplayer menu.
     */
    _ensureServersDat(){
        try {
            const serversDatPath = path.join(this.gameDir, 'servers.dat')
            if(!fs.existsSync(serversDatPath) && this.server && this.server.hostname){
                const sName = this.server.rawServer.name || 'Velvet Abyss RP'
                const sIp = (this.server.port && this.server.port !== 25565) ? `${this.server.hostname}:${this.server.port}` : this.server.hostname
                const nameBuf = Buffer.from(sName, 'utf8')
                const ipBuf = Buffer.from(sIp, 'utf8')
                const nbt = Buffer.concat([
                    Buffer.from([0x0A, 0x00, 0x00]), // Root Compound
                    Buffer.from([0x09, 0x00, 0x07, 0x73, 0x65, 0x72, 0x76, 0x65, 0x72, 0x73]), // TAG_List 'servers'
                    Buffer.from([0x0A, 0x00, 0x00, 0x00, 0x01]), // Element type TAG_Compound (10), length 1
                    Buffer.from([0x08, 0x00, 0x04, 0x6E, 0x61, 0x6D, 0x65]), // TAG_String 'name'
                    Buffer.from([nameBuf.length >> 8, nameBuf.length & 0xFF]),
                    nameBuf,
                    Buffer.from([0x08, 0x00, 0x02, 0x69, 0x70]), // TAG_String 'ip'
                    Buffer.from([ipBuf.length >> 8, ipBuf.length & 0xFF]),
                    ipBuf,
                    Buffer.from([0x00]), // End of server compound
                    Buffer.from([0x00])  // End of root compound
                ])
                fs.writeFileSync(serversDatPath, nbt)
                logger.info('Auto-generated servers.dat for multiplayer list')
            }
        } catch (e) {
            logger.warn('Could not ensure default servers.dat', e)
        }
    }

    /**
     * Ensure critical mod configs exist (like entity_texture_features.json) so they do not crash
     * on fresh installs due to early initialization bugs.
     */
    _ensureDefaultConfigs(){
        try {
            const configDir = path.join(this.gameDir, 'config')
            fs.ensureDirSync(configDir)
            const etfPath = path.join(configDir, 'entity_texture_features.json')
            if(!fs.existsSync(etfPath)){
                const defaultEtf = {
                    "optifine_limitRandomVariantGapsBy10": false,
                    "optifine_allowWeirdSkipsInTrueRandom": true,
                    "optifine_preventBaseTextureInOptifineDirectory": true,
                    "illegalPathSupportMode": "None",
                    "enableCustomTextures": true,
                    "enableCustomBlockEntities": true,
                    "textureUpdateFrequency_V2": "Fast",
                    "enableEmissiveTextures": true,
                    "enableEnchantedTextures": true,
                    "enableEmissiveBlockEntities": true,
                    "emissiveRenderMode": "DULL",
                    "alwaysCheckVanillaEmissiveSuffix": true,
                    "enableArmorAndTrims": true,
                    "skinFeaturesEnabled": true,
                    "skinTransparencyMode": "ETF_SKINS_ONLY",
                    "skinTransparencyInExtraPixels": true,
                    "skinFeaturesEnableTransparency": true,
                    "skinFeaturesEnableFullTransparency": false,
                    "tryETFTransparencyForAllSkins": false,
                    "enableEnemyTeamPlayersSkinFeatures": true,
                    "enableBlinking": true,
                    "blinkFrequency": 150,
                    "blinkLength": 1,
                    "advanced_IncreaseCacheSizeModifier": 1.0,
                    "debugLoggingMode": "None",
                    "logTextureDataInitialization": false,
                    "hideConfigButton": false,
                    "stackDebugPrinting": false,
                    "configButtonLoc": "BOTTOM_RIGHT",
                    "disableVanillaDirectoryVariantTextures": false,
                    "use3DSkinLayerPatch": true,
                    "enableFullBodyWardenTextures": true,
                    "entityEmissiveOverrides": {},
                    "propertiesDisabled": [],
                    "propertyInvertUpdatingOverrides": [],
                    "entityRandomOverrides": {},
                    "entityEmissiveBrightOverrides": {},
                    "entityRenderLayerOverrides": {},
                    "entityLightOverrides": {}
                }
                fs.writeFileSync(etfPath, JSON.stringify(defaultEtf, null, 2))
                logger.info('Auto-generated default entity_texture_features.json to prevent early init crash')
            }

            const etfSubDir = path.join(configDir, 'etf')
            fs.ensureDirSync(etfSubDir)
            const etfSubPath = path.join(etfSubDir, 'entity_texture_features.json')
            if(!fs.existsSync(etfSubPath)){
                fs.copyFileSync(etfPath, etfSubPath)
                logger.info('Auto-generated default config/etf/entity_texture_features.json')
            }

            const emfPath = path.join(configDir, 'entity_model_features.json')
            if(!fs.existsSync(emfPath)){
                const defaultEmf = {
                    "allowedCEM": "ALL",
                    "logModelCreationData": false,
                    "debugOnRightClick": false,
                    "renderModeChoice": "NORMAL",
                    "vanillaModelHologramRenderMode_2": "OFF",
                    "modelExportMode": "NONE",
                    "automaticModelExporting": false,
                    "attemptPhysicsModPatch_2": "CUSTOM",
                    "modelUpdateFrequency": "Average",
                    "entityRenderModeOverrides": {},
                    "entityPhysicsModPatchOverrides": {},
                    "entityVanillaHologramOverrides": {},
                    "modelsNamesDisabled": [],
                    "allowEBEModConfigModify": true,
                    "animationLODDistance": 20,
                    "retainDetailOnLowFps": true,
                    "retainDetailOnLargerMobs": true,
                    "animationFrameSkipDuringIrisShadowPass": true,
                    "preventFirstPersonHandAnimating": false,
                    "onlyClientPlayerModel": false,
                    "doubleChestAnimFix": true,
                    "enforceOptifineVariationRequiresDefaultModel": false,
                    "enforceOptifineVariationRequiresDefaultModel_v2": false,
                    "resetPlayerModelEachRender": true,
                    "resetPlayerModelEachRender_v2": true,
                    "onlyDebugRenderOnHover": false,
                    "enforceOptifineSubFoldersVariantOnly": false,
                    "enforceOptiFineAnimSyntaxLimits": true,
                    "allowOptifineFallbackProperties": true,
                    "enforceOptiFineFloorUVs": true,
                    "showReloadErrorToast": true,
                    "exportRotations": false,
                    "asmMaths": true,
                    "logASM": false
                }
                fs.writeFileSync(emfPath, JSON.stringify(defaultEmf, null, 2))
                logger.info('Auto-generated default entity_model_features.json')
            }
        } catch (e) {
            logger.warn('Could not ensure default configs', e)
        }
    }

    /**
     * Ensure Emotes.zip is extracted into the instance emotes/ directory.
     */
    _ensureEmotesExtracted(){
        try {
            const emotesZip = path.join(this.gameDir, 'Emotes.zip')
            const emotesDir = path.join(this.gameDir, 'emotes')
            if (fs.existsSync(emotesZip)) {
                fs.ensureDirSync(emotesDir)
                const fileCount = fs.readdirSync(emotesDir).length
                if (fileCount === 0) {
                    logger.info('Auto-extracting Emotes.zip into instance directory...')
                    const AdmZip = require('adm-zip')
                    const zip = new AdmZip(emotesZip)
                    zip.extractAllTo(this.gameDir, true)
                    logger.info('Emotes.zip extracted successfully!')
                }
            }
        } catch (e) {
            logger.warn('Could not extract Emotes.zip', e)
        }
    }

    /**
     * Get the platform specific classpath separator. On windows, this is a semicolon.
     * On Unix, this is a colon.
     * 
     * @returns {string} The classpath separator for the current operating system.
     */
    static getClasspathSeparator() {
        return process.platform === 'win32' ? ';' : ':'
    }

    /**
     * Determine if an optional mod is enabled from its configuration value. If the
     * configuration value is null, the required object will be used to
     * determine if it is enabled.
     * 
     * A mod is enabled if:
     *   * The configuration is not null and one of the following:
     *     * The configuration is a boolean and true.
     *     * The configuration is an object and its 'value' property is true.
     *   * The configuration is null and one of the following:
     *     * The required object is null.
     *     * The required object's 'def' property is null or true.
     * 
     * @param {Object | boolean} modCfg The mod configuration object.
     * @param {Object} required Optional. The required object from the mod's distro declaration.
     * @returns {boolean} True if the mod is enabled, false otherwise.
     */
    static isModEnabled(modCfg, required = null){
        return modCfg != null ? ((typeof modCfg === 'boolean' && modCfg) || (typeof modCfg === 'object' && (typeof modCfg.value !== 'undefined' ? modCfg.value : true))) : required != null ? required.def : true
    }

    /**
     * Function which performs a preliminary scan of the top level
     * mods. If liteloader is present here, we setup the special liteloader
     * launch options. Note that liteloader is only allowed as a top level
     * mod. It must not be declared as a submodule.
     */
    setupLiteLoader(){
        for(let ll of this.server.modules){
            if(ll.rawModule.type === Type.LiteLoader){
                if(!ll.getRequired().value){
                    const modCfg = ConfigManager.getModConfiguration(this.server.rawServer.id).mods
                    if(ProcessBuilder.isModEnabled(modCfg[ll.getVersionlessMavenIdentifier()], ll.getRequired())){
                        if(fs.existsSync(ll.getPath())){
                            this.usingLiteLoader = true
                            this.llPath = ll.getPath()
                        }
                    }
                } else {
                    if(fs.existsSync(ll.getPath())){
                        this.usingLiteLoader = true
                        this.llPath = ll.getPath()
                    }
                }
            }
        }
    }

    /**
     * Resolve an array of all enabled mods. These mods will be constructed into
     * a mod list format and enabled at launch.
     * 
     * @param {Object} modCfg The mod configuration object.
     * @param {Array.<Object>} mdls An array of modules to parse.
     * @returns {{fMods: Array.<Object>, lMods: Array.<Object>}} An object which contains
     * a list of enabled forge mods and litemods.
     */
    resolveModConfiguration(modCfg, mdls){
        let fMods = []
        let lMods = []

        for(let mdl of mdls){
            const type = mdl.rawModule.type
            if(type === Type.ForgeMod || type === Type.LiteMod || type === Type.LiteLoader || type === Type.FabricMod){
                const o = !mdl.getRequired().value
                const e = ProcessBuilder.isModEnabled(modCfg[mdl.getVersionlessMavenIdentifier()], mdl.getRequired())
                if(!o || (o && e)){
                    if(mdl.subModules.length > 0){
                        const v = this.resolveModConfiguration(modCfg[mdl.getVersionlessMavenIdentifier()].mods, mdl.subModules)
                        fMods = fMods.concat(v.fMods)
                        lMods = lMods.concat(v.lMods)
                        if(type === Type.LiteLoader){
                            continue
                        }
                    }
                    if(type === Type.ForgeMod || type === Type.FabricMod){
                        fMods.push(mdl)
                    } else {
                        lMods.push(mdl)
                    }
                }
            }
        }

        return {
            fMods,
            lMods
        }
    }

    _lteMinorVersion(version) {
        return Number(this.modManifest.id.split('-')[0].split('.')[1]) <= Number(version)
    }

    /**
     * Test to see if this version of forge requires the absolute: prefix
     * on the modListFile repository field.
     */
    _requiresAbsolute(){
        try {
            if(this._lteMinorVersion(9)) {
                return false
            }
            const ver = this.modManifest.id.split('-')[2]
            const pts = ver.split('.')
            const min = [14, 23, 3, 2655]
            for(let i=0; i<pts.length; i++){
                const parsed = Number.parseInt(pts[i])
                if(parsed < min[i]){
                    return false
                } else if(parsed > min[i]){
                    return true
                }
            }
        } catch (_err) {
            // We know old forge versions follow this format.
            // Error must be caused by newer version.
        }
        
        // Equal or errored
        return true
    }

    /**
     * Construct a mod list json object.
     * 
     * @param {'forge' | 'liteloader'} type The mod list type to construct.
     * @param {Array.<Object>} mods An array of mods to add to the mod list.
     * @param {boolean} save Optional. Whether or not we should save the mod list file.
     */
    constructJSONModList(type, mods, save = false){
        const modList = {
            repositoryRoot: ((type === 'forge' && this._requiresAbsolute()) ? 'absolute:' : '') + path.join(this.commonDir, 'modstore')
        }

        const ids = []
        if(type === 'forge'){
            for(let mod of mods){
                ids.push(mod.getExtensionlessMavenIdentifier())
            }
        } else {
            for(let mod of mods){
                ids.push(mod.getMavenIdentifier())
            }
        }
        modList.modRef = ids
        
        if(save){
            const json = JSON.stringify(modList, null, 4)
            fs.writeFileSync(type === 'forge' ? this.fmlDir : this.llDir, json, 'UTF-8')
        }

        return modList
    }

    // /**
    //  * Construct the mod argument list for forge 1.13
    //  * 
    //  * @param {Array.<Object>} mods An array of mods to add to the mod list.
    //  */
    // constructModArguments(mods){
    //     const argStr = mods.map(mod => {
    //         return mod.getExtensionlessMavenIdentifier()
    //     }).join(',')

    //     if(argStr){
    //         return [
    //             '--fml.mavenRoots',
    //             path.join('..', '..', 'common', 'modstore'),
    //             '--fml.mods',
    //             argStr
    //         ]
    //     } else {
    //         return []
    //     }
        
    // }

    /**
     * Construct the mod argument list for forge 1.13 and Fabric
     * 
     * @param {Array.<Object>} mods An array of mods to add to the mod list.
     */
    constructModList(mods) {
        const writeBuffer = mods.map(mod => {
            return this.usingFabricLoader ? mod.getPath() : mod.getExtensionlessMavenIdentifier()
        }).join('\n')

        if(writeBuffer) {
            fs.writeFileSync(this.forgeModListFile, writeBuffer, 'UTF-8')
            return this.usingFabricLoader ? [
                '--fabric.addMods',
                `@${this.forgeModListFile}`
            ] : [
                '--fml.mavenRoots',
                path.join('..', '..', 'common', 'modstore'),
                '--fml.modLists',
                this.forgeModListFile
            ]
        } else {
            return []
        }

    }

    _processAutoConnectArg(args){
        if(ConfigManager.getAutoConnect() && this.server.rawServer.autoconnect){
            if(mcVersionAtLeast('1.20', this.server.rawServer.minecraftVersion)){
                args.push('--quickPlayMultiplayer')
                args.push(`${this.server.hostname}:${this.server.port}`)
            } else {
                args.push('--server')
                args.push(this.server.hostname)
                args.push('--port')
                args.push(this.server.port)
            }
        }
    }

    /**
     * Construct the argument array that will be passed to the JVM process.
     * 
     * @param {Array.<Object>} mods An array of enabled mods which will be launched with this process.
     * @param {string} tempNativePath The path to store the native libraries.
     * @returns {Array.<string>} An array containing the full JVM arguments for this process.
     */
    constructJVMArguments(mods, tempNativePath){
        if(mcVersionAtLeast('1.13', this.server.rawServer.minecraftVersion)){
            return this._constructJVMArguments113(mods, tempNativePath)
        } else {
            return this._constructJVMArguments112(mods, tempNativePath)
        }
    }

    /**
     * Construct the argument array that will be passed to the JVM process.
     * This function is for 1.12 and below.
     * 
     * @param {Array.<Object>} mods An array of enabled mods which will be launched with this process.
     * @param {string} tempNativePath The path to store the native libraries.
     * @returns {Array.<string>} An array containing the full JVM arguments for this process.
     */
    _constructJVMArguments112(mods, tempNativePath){

        let args = []

        // Classpath Argument
        args.push('-cp')
        args.push(this.classpathArg(mods, tempNativePath).join(ProcessBuilder.getClasspathSeparator()))

        // Java Arguments
        if(process.platform === 'darwin'){
            args.push('-Xdock:name=VelvetLauncher')
            args.push('-Xdock:icon=' + path.join(__dirname, '..', 'images', 'minecraft.icns'))
        }
        args.push('-Xmx' + ConfigManager.getMaxRAM(this.server.rawServer.id))
        args.push('-Xms' + ConfigManager.getMinRAM(this.server.rawServer.id))
        args = args.concat(ConfigManager.getJVMOptions(this.server.rawServer.id))
        args.push('-Djava.library.path=' + tempNativePath)

        // Main Java Class
        args.push(this.modManifest.mainClass)

        // Forge Arguments
        args = args.concat(this._resolveForgeArgs())

        return args
    }

    /**
     * Construct the argument array that will be passed to the JVM process.
     * This function is for 1.13+
     * 
     * Note: Required Libs https://github.com/MinecraftForge/MinecraftForge/blob/af98088d04186452cb364280340124dfd4766a5c/src/fmllauncher/java/net/minecraftforge/fml/loading/LibraryFinder.java#L82
     * 
     * @param {Array.<Object>} mods An array of enabled mods which will be launched with this process.
     * @param {string} tempNativePath The path to store the native libraries.
     * @returns {Array.<string>} An array containing the full JVM arguments for this process.
     */
    _constructJVMArguments113(mods, tempNativePath){

        const argDiscovery = /\${*(.*)}/

        // JVM Arguments First
        let args = this.vanillaManifest.arguments.jvm

        // Debug securejarhandler
        // args.push('-Dbsl.debug=true')

        if(this.modManifest.arguments.jvm != null) {
            for(const argStr of this.modManifest.arguments.jvm) {
                let formatted = argStr
                    .replaceAll('${library_directory}', this.libPath)
                    .replaceAll('${classpath_separator}', ProcessBuilder.getClasspathSeparator())
                    .replaceAll('${version_name}', this.modManifest.id)
                if(formatted.startsWith('-DignoreList=')) {
                    formatted += ',client,client-'
                }
                args.push(formatted)
            }
        }

        //args.push('-Dlog4j.configurationFile=D:\\WesterosCraft\\game\\common\\assets\\log_configs\\client-1.12.xml')

        // Java Arguments
        if(process.platform === 'darwin'){
            args.push('-Xdock:name=VelvetLauncher')
            args.push('-Xdock:icon=' + path.join(__dirname, '..', 'images', 'minecraft.icns'))
        }
        args.push('-Xmx' + ConfigManager.getMaxRAM(this.server.rawServer.id))
        args.push('-Xms' + ConfigManager.getMinRAM(this.server.rawServer.id))
        args = args.concat(ConfigManager.getJVMOptions(this.server.rawServer.id))

        // Main Java Class
        args.push(this.modManifest.mainClass)

        // Vanilla Arguments
        args = args.concat(this.vanillaManifest.arguments.game)

        for(let i=0; i<args.length; i++){
            if(typeof args[i] === 'object' && args[i].rules != null){
                
                let checksum = 0
                for(let rule of args[i].rules){
                    if(rule.os != null){
                        if(rule.os.name === getMojangOS()
                            && (rule.os.version == null || new RegExp(rule.os.version).test(os.release))){
                            if(rule.action === 'allow'){
                                checksum++
                            }
                        } else {
                            if(rule.action === 'disallow'){
                                checksum++
                            }
                        }
                    } else if(rule.features != null){
                        // We don't have many 'features' in the index at the moment.
                        // This should be fine for a while.
                        if(rule.features.has_custom_resolution != null && rule.features.has_custom_resolution === true){
                            if(ConfigManager.getFullscreen()){
                                args[i].value = [
                                    '--fullscreen',
                                    'true'
                                ]
                            }
                            checksum++
                        }
                    }
                }

                // TODO splice not push
                if(checksum === args[i].rules.length){
                    if(typeof args[i].value === 'string'){
                        args[i] = args[i].value
                    } else if(typeof args[i].value === 'object'){
                        //args = args.concat(args[i].value)
                        args.splice(i, 1, ...args[i].value)
                    }

                    // Decrement i to reprocess the resolved value
                    i--
                } else {
                    args[i] = null
                }

            } else if(typeof args[i] === 'string'){
                if(argDiscovery.test(args[i])){
                    const identifier = args[i].match(argDiscovery)[1]
                    let val = null
                    switch(identifier){
                        case 'auth_player_name':
                            val = this.authUser.displayName.trim()
                            break
                        case 'version_name':
                            //val = vanillaManifest.id
                            val = this.server.rawServer.id
                            break
                        case 'game_directory':
                            val = this.gameDir
                            break
                        case 'assets_root':
                            val = path.join(this.commonDir, 'assets')
                            break
                        case 'assets_index_name':
                            val = this.vanillaManifest.assets
                            break
                        case 'auth_uuid':
                            val = this.authUser.uuid.trim()
                            break
                        case 'auth_access_token':
                            val = this.authUser.accessToken
                            break
                        case 'user_type':
                            val = this.authUser.type === 'microsoft' ? 'msa' : 'mojang'
                            break
                        case 'version_type':
                            val = this.vanillaManifest.type
                            break
                        case 'resolution_width':
                            val = ConfigManager.getGameWidth()
                            break
                        case 'resolution_height':
                            val = ConfigManager.getGameHeight()
                            break
                        case 'natives_directory':
                            val = args[i].replace(argDiscovery, tempNativePath)
                            break
                        case 'launcher_name':
                            val = args[i].replace(argDiscovery, 'VelvetLauncher')
                            break
                        case 'launcher_version':
                            val = args[i].replace(argDiscovery, this.launcherVersion)
                            break
                        case 'classpath':
                            val = this.classpathArg(mods, tempNativePath).join(ProcessBuilder.getClasspathSeparator())
                            break
                    }
                    if(val != null){
                        args[i] = val
                    }
                }
            }
        }

        // Autoconnect
        this._processAutoConnectArg(args)
        

        // Forge Specific Arguments
        args = args.concat(this.modManifest.arguments.game)

        // Filter null values
        args = args.filter(arg => {
            return arg != null
        })

        return args
    }

    /**
     * Resolve the arguments required by forge.
     * 
     * @returns {Array.<string>} An array containing the arguments required by forge.
     */
    _resolveForgeArgs(){
        const mcArgs = this.modManifest.minecraftArguments.split(' ')
        const argDiscovery = /\${*(.*)}/

        // Replace the declared variables with their proper values.
        for(let i=0; i<mcArgs.length; ++i){
            if(argDiscovery.test(mcArgs[i])){
                const identifier = mcArgs[i].match(argDiscovery)[1]
                let val = null
                switch(identifier){
                    case 'auth_player_name':
                        val = this.authUser.displayName.trim()
                        break
                    case 'version_name':
                        //val = vanillaManifest.id
                        val = this.server.rawServer.id
                        break
                    case 'game_directory':
                        val = this.gameDir
                        break
                    case 'assets_root':
                        val = path.join(this.commonDir, 'assets')
                        break
                    case 'assets_index_name':
                        val = this.vanillaManifest.assets
                        break
                    case 'auth_uuid':
                        val = this.authUser.uuid.trim()
                        break
                    case 'auth_access_token':
                        val = this.authUser.accessToken
                        break
                    case 'user_type':
                        val = this.authUser.type === 'microsoft' ? 'msa' : 'mojang'
                        break
                    case 'user_properties': // 1.8.9 and below.
                        val = '{}'
                        break
                    case 'version_type':
                        val = this.vanillaManifest.type
                        break
                }
                if(val != null){
                    mcArgs[i] = val
                }
            }
        }

        // Autoconnect to the selected server.
        this._processAutoConnectArg(mcArgs)

        // Prepare game resolution
        if(ConfigManager.getFullscreen()){
            mcArgs.push('--fullscreen')
            mcArgs.push(true)
        } else {
            mcArgs.push('--width')
            mcArgs.push(ConfigManager.getGameWidth())
            mcArgs.push('--height')
            mcArgs.push(ConfigManager.getGameHeight())
        }
        
        // Mod List File Argument
        mcArgs.push('--modListFile')
        if(this._lteMinorVersion(9)) {
            mcArgs.push(path.basename(this.fmlDir))
        } else {
            mcArgs.push('absolute:' + this.fmlDir)
        }
        

        // LiteLoader
        if(this.usingLiteLoader){
            mcArgs.push('--modRepo')
            mcArgs.push(this.llDir)

            // Set first arg to liteloader tweak class
            mcArgs.unshift('com.mumfrey.liteloader.launch.LiteLoaderTweaker')
            mcArgs.unshift('--tweakClass')
        }

        return mcArgs
    }

    /**
     * Ensure that the classpath entries all point to jar files.
     * 
     * @param {Array.<String>} list Array of classpath entries.
     */
    _processClassPathList(list) {

        const ext = '.jar'
        const extLen = ext.length
        for(let i=0; i<list.length; i++) {
            const extIndex = list[i].indexOf(ext)
            if(extIndex > -1 && extIndex  !== list[i].length - extLen) {
                list[i] = list[i].substring(0, extIndex + extLen)
            }
        }

    }

    /**
     * Resolve the full classpath argument list for this process. This method will resolve all Mojang-declared
     * libraries as well as the libraries declared by the server. Since mods are permitted to declare libraries,
     * this method requires all enabled mods as an input
     * 
     * @param {Array.<Object>} mods An array of enabled mods which will be launched with this process.
     * @param {string} tempNativePath The path to store the native libraries.
     * @returns {Array.<string>} An array containing the paths of each library required by this process.
     */
    classpathArg(mods, tempNativePath){
        let cpArgs = []

        if(!mcVersionAtLeast('1.17', this.server.rawServer.minecraftVersion) || this.usingFabricLoader) {
            // Add the version.jar to the classpath.
            // Must not be added to the classpath for Forge 1.17+.
            const version = this.vanillaManifest.id
            cpArgs.push(path.join(this.commonDir, 'versions', version, version + '.jar'))
        } else {
            // For Forge 1.17+, vanilla assets/lang are provided by client-extra.jar
            const clientDir = path.join(this.commonDir, 'libraries', 'net', 'minecraft', 'client', '1.20.1-20230612.114412')
            const extraJar = path.join(clientDir, 'client-1.20.1-20230612.114412-extra.jar')
            if(fs.existsSync(extraJar)){
                cpArgs.push(extraJar)
            }
        }
        

        if(this.usingLiteLoader){
            cpArgs.push(this.llPath)
        }

        // Resolve the Mojang declared libraries.
        const mojangLibs = this._resolveMojangLibraries(tempNativePath)

        // Resolve the server declared libraries.
        const servLibs = this._resolveServerLibraries(mods)

        // Merge libraries, server libs with the same
        // maven identifier will override the mojang ones.
        // Ex. 1.7.10 forge overrides mojang's guava with newer version.
        const finalLibs = {...mojangLibs, ...servLibs}
        cpArgs = cpArgs.concat(Object.values(finalLibs))

        this._processClassPathList(cpArgs)

        if(mcVersionAtLeast('1.17', this.server.rawServer.minecraftVersion) && !this.usingFabricLoader) {
            // For Forge 1.17+, client-srg is discovered dynamically by MinecraftLocator
            // and must NOT be on the classpath to prevent duplicate 'client' and 'minecraft' modules.
            // client-extra MUST remain on the classpath for vanilla assets/lang.
            cpArgs = cpArgs.filter(jar => (!jar.includes('client-1.20.1') || jar.includes('-extra.jar')) && !jar.endsWith('-srg.jar'))
        }

        return cpArgs
    }

    /**
     * Resolve the libraries defined by Mojang's version data. This method will also extract
     * native libraries and point to the correct location for its classpath.
     * 
     * TODO - clean up function
     * 
     * @param {string} tempNativePath The path to store the native libraries.
     * @returns {{[id: string]: string}} An object containing the paths of each library mojang declares.
     */
    _resolveMojangLibraries(tempNativePath){
        const nativesRegex = /.+:natives-([^-]+)(?:-(.+))?/
        const libs = {}

        const libArr = this.vanillaManifest.libraries
        fs.ensureDirSync(tempNativePath)
        for(let i=0; i<libArr.length; i++){
            const lib = libArr[i]
            if(isLibraryCompatible(lib.rules, lib.natives)){

                // Pre-1.19 has a natives object.
                if(lib.natives != null) {
                    // Extract the native library.
                    const exclusionArr = lib.extract != null ? lib.extract.exclude : ['META-INF/']
                    const artifact = lib.downloads.classifiers[lib.natives[getMojangOS()].replace('${arch}', process.arch.replace('x', ''))]

                    // Location of native zip.
                    const to = path.join(this.libPath, artifact.path)

                    let zip = new AdmZip(to)
                    let zipEntries = zip.getEntries()

                    // Unzip the native zip.
                    for(let i=0; i<zipEntries.length; i++){
                        const fileName = zipEntries[i].entryName

                        let shouldExclude = false

                        // Exclude noted files.
                        exclusionArr.forEach(function(exclusion){
                            if(fileName.indexOf(exclusion) > -1){
                                shouldExclude = true
                            }
                        })

                        // Extract the file.
                        if(!shouldExclude){
                            fs.writeFile(path.join(tempNativePath, fileName), zipEntries[i].getData(), (err) => {
                                if(err){
                                    logger.error('Error while extracting native library:', err)
                                }
                            })
                        }

                    }
                }
                // 1.19+ logic
                else if(lib.name.includes('natives-')) {

                    const regexTest = nativesRegex.exec(lib.name)
                    // const os = regexTest[1]
                    const arch = regexTest[2] ?? 'x64'

                    if(arch != process.arch) {
                        continue
                    }

                    // Extract the native library.
                    const exclusionArr = lib.extract != null ? lib.extract.exclude : ['META-INF/', '.git', '.sha1']
                    const artifact = lib.downloads.artifact

                    // Location of native zip.
                    const to = path.join(this.libPath, artifact.path)

                    let zip = new AdmZip(to)
                    let zipEntries = zip.getEntries()

                    // Unzip the native zip.
                    for(let i=0; i<zipEntries.length; i++){
                        if(zipEntries[i].isDirectory) {
                            continue
                        }

                        const fileName = zipEntries[i].entryName

                        let shouldExclude = false

                        // Exclude noted files.
                        exclusionArr.forEach(function(exclusion){
                            if(fileName.indexOf(exclusion) > -1){
                                shouldExclude = true
                            }
                        })

                        const extractName = fileName.includes('/') ? fileName.substring(fileName.lastIndexOf('/')) : fileName

                        // Extract the file.
                        if(!shouldExclude){
                            fs.writeFile(path.join(tempNativePath, extractName), zipEntries[i].getData(), (err) => {
                                if(err){
                                    logger.error('Error while extracting native library:', err)
                                }
                            })
                        }

                    }
                }
                // No natives
                else {
                    const dlInfo = lib.downloads
                    const artifact = dlInfo.artifact
                    const to = path.join(this.libPath, artifact.path)
                    const versionIndependentId = lib.name.substring(0, lib.name.lastIndexOf(':'))
                    libs[versionIndependentId] = to
                }
            }
        }

        return libs
    }

    /**
     * Resolve the libraries declared by this server in order to add them to the classpath.
     * This method will also check each enabled mod for libraries, as mods are permitted to
     * declare libraries.
     * 
     * @param {Array.<Object>} mods An array of enabled mods which will be launched with this process.
     * @returns {{[id: string]: string}} An object containing the paths of each library this server requires.
     */
    _resolveServerLibraries(mods){
        const mdls = this.server.modules
        let libs = {}

        // Locate Forge/Fabric/Libraries
        for(let mdl of mdls){
            const type = mdl.rawModule.type
            if(type === Type.ForgeHosted || type === Type.Fabric || type === Type.Library){
                libs[mdl.getVersionlessMavenIdentifier()] = mdl.getPath()
                if(mdl.subModules.length > 0){
                    const res = this._resolveModuleLibraries(mdl)
                    libs = {...libs, ...res}
                }
            }
        }

        //Check for any libraries in our mod list.
        for(let i=0; i<mods.length; i++){
            if(mods.sub_modules != null){
                const res = this._resolveModuleLibraries(mods[i])
                libs = {...libs, ...res}
            }
        }

        return libs
    }

    /**
     * Recursively resolve the path of each library required by this module.
     * 
     * @param {Object} mdl A module object from the server distro index.
     * @returns {{[id: string]: string}} An object containing the paths of each library this module requires.
     */
    _resolveModuleLibraries(mdl){
        if(!mdl.subModules.length > 0){
            return {}
        }
        let libs = {}
        for(let sm of mdl.subModules){
            if(sm.rawModule.type === Type.Library){

                if(sm.rawModule.classpath ?? true) {
                    libs[sm.getVersionlessMavenIdentifier()] = sm.getPath()
                }
            }
            // If this module has submodules, we need to resolve the libraries for those.
            // To avoid unnecessary recursive calls, base case is checked here.
            if(mdl.subModules.length > 0){
                const res = this._resolveModuleLibraries(sm)
                libs = {...libs, ...res}
            }
        }
        return libs
    }

}

module.exports = ProcessBuilder