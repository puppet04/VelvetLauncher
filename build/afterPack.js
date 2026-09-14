const fs = require('fs')
const path = require('path')

exports.default = async function (context) {
    const appOutDir = context.appOutDir
    console.log('[AFTER-PACK] Otimizando tamanho do pacote em:', appOutDir)

    // 1. Limpar locales desnecessários do Chromium
    const localesDir = path.join(appOutDir, 'locales')
    if (fs.existsSync(localesDir)) {
        const keepLocales = new Set(['en-US.pak', 'pt-BR.pak', 'pt-PT.pak', 'en-GB.pak'])
        const files = fs.readdirSync(localesDir)
        let removedCount = 0
        for (const file of files) {
            if (!keepLocales.has(file)) {
                try {
                    fs.unlinkSync(path.join(localesDir, file))
                    removedCount++
                } catch (e) { }
            }
        }
        console.log(`[AFTER-PACK] Removidos ${removedCount} arquivos de idiomas não utilizados em locales/`)
    }

    // 2. Limpar arquivo de licenças do Chromium (19.5 MB desnecessários no cliente final)
    const licenseHtml = path.join(appOutDir, 'LICENSES.chromium.html')
    if (fs.existsSync(licenseHtml)) {
        try {
            fs.unlinkSync(licenseHtml)
            console.log('[AFTER-PACK] Removido LICENSES.chromium.html (economizou ~20MB)')
        } catch (e) { }
    }

    // 3. Limpar compiladores WebGPU não utilizados (dxcompiler.dll e dxil.dll - economiza ~27MB)
    const webgpuDlls = ['dxcompiler.dll', 'dxil.dll']
    for (const dll of webgpuDlls) {
        const dllPath = path.join(appOutDir, dll)
        if (fs.existsSync(dllPath)) {
            try {
                fs.unlinkSync(dllPath)
                console.log(`[AFTER-PACK] Removido ${dll}`)
            } catch (e) { }
        }
    }
}
