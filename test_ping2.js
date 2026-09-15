const { getServerStatus } = require('helios-core/mojang');

async function test() {
    try {
        const servStat = await getServerStatus(763, 'velvet.enxada.host', 25565);
        console.log('Success:', servStat);
    } catch (e) {
        console.error('Failed:', e);
    }
}
test();
