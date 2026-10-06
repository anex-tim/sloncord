using System.Text.Json;
using Microsoft.Extensions.Configuration;
using WebPush;

namespace Sloncord;

internal sealed class VapidKeyStore
{
    public string PublicKey { get; private set; } = string.Empty;
    public string PrivateKey { get; private set; } = string.Empty;
    public string Subject { get; private set; } = "mailto:admin@136.234.12.106";

    public static VapidKeyStore LoadOrCreate(IConfiguration configuration, string dataDir)
    {
        var store = new VapidKeyStore();
        var fromConfig = configuration.GetSection("Sloncord:Vapid");
        var pub = fromConfig["PublicKey"]?.Trim() ?? string.Empty;
        var priv = fromConfig["PrivateKey"]?.Trim() ?? string.Empty;
        var subj = fromConfig["Subject"]?.Trim() ?? string.Empty;
        if (!string.IsNullOrWhiteSpace(subj)) store.Subject = subj;

        if (!string.IsNullOrWhiteSpace(pub) && !string.IsNullOrWhiteSpace(priv))
        {
            store.PublicKey = pub;
            store.PrivateKey = priv;
            return store;
        }

        Directory.CreateDirectory(dataDir);
        var path = Path.Combine(dataDir, "vapid.json");
        if (File.Exists(path))
        {
            try
            {
                var json = JsonSerializer.Deserialize<VapidFile>(File.ReadAllText(path), SloncordJson.Options);
                if (json is { PublicKey: { Length: > 0 } p1, PrivateKey: { Length: > 0 } p2 })
                {
                    store.PublicKey = p1;
                    store.PrivateKey = p2;
                    if (!string.IsNullOrWhiteSpace(json.Subject)) store.Subject = json.Subject!;
                    return store;
                }
            }
            catch
            {
                // fall through: regenerate
            }
        }

        var keys = VapidHelper.GenerateVapidKeys();
        store.PublicKey = keys.PublicKey;
        store.PrivateKey = keys.PrivateKey;

        File.WriteAllText(path, JsonSerializer.Serialize(
            new VapidFile
            {
                PublicKey = store.PublicKey,
                PrivateKey = store.PrivateKey,
                Subject = store.Subject
            },
            new JsonSerializerOptions { WriteIndented = true }));

        return store;
    }

    private sealed class VapidFile
    {
        public string PublicKey { get; set; } = string.Empty;
        public string PrivateKey { get; set; } = string.Empty;
        public string? Subject { get; set; }
    }
}
