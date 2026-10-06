using System.Text.Encodings.Web;
using Microsoft.AspNetCore.Authentication;
using Microsoft.Extensions.Options;

namespace Sloncord;

/// <summary>
/// Sloncord uses custom Bearer tokens in DB, not ASP.NET Identity.
/// This handler exists so <see cref="Results.Forbid"/> and authorization middleware
/// can run without throwing "IAuthenticationService not registered".
/// </summary>
internal sealed class SloncordPassthroughAuthHandler : AuthenticationHandler<AuthenticationSchemeOptions>
{
    public SloncordPassthroughAuthHandler(
        IOptionsMonitor<AuthenticationSchemeOptions> options,
        ILoggerFactory logger,
        UrlEncoder encoder)
        : base(options, logger, encoder)
    {
    }

    protected override Task<AuthenticateResult> HandleAuthenticateAsync()
        => Task.FromResult(AuthenticateResult.NoResult());
}
