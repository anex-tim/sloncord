var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

app.UseDefaultFiles();
app.UseStaticFiles();

app.MapGet("/health", () => Results.Ok(new { service = "Sloncord Web Client", status = "ok" }));

app.Run("http://localhost:5001");
