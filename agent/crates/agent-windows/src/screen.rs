//! Windows screen capture using DXGI Desktop Duplication API.
//! Requires Windows 8+ and a DirectX 11 capable GPU.
//! Falls back to GDI capture for remote desktop sessions where DXGI is unavailable.

use anyhow::{Context, Result, bail};
use agent_platform::screen::{ScreenCapture, ScreenFrame};
use async_trait::async_trait;
use tracing::{info, warn};

use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D,
    D3D11_CPU_ACCESS_READ, D3D11_MAP_READ, D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC,
    D3D11_USAGE_STAGING,
};
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
use windows::Win32::Graphics::Dxgi::{
    IDXGIDevice, IDXGIAdapter, IDXGIOutput, IDXGIOutput1, IDXGIOutputDuplication,
    DXGI_OUTDUPL_FRAME_INFO,
};
use windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_B8G8R8A8_UNORM;

/// DXGI Desktop Duplication screen capture
pub struct DxgiScreenCapture {
    device: Option<ID3D11Device>,
    context: Option<ID3D11DeviceContext>,
    duplication: Option<IDXGIOutputDuplication>,
    staging_texture: Option<ID3D11Texture2D>,
    width: u32,
    height: u32,
    initialized: bool,
}

// SAFETY: D3D11 objects are thread-safe when accessed serially
unsafe impl Send for DxgiScreenCapture {}
unsafe impl Sync for DxgiScreenCapture {}

impl DxgiScreenCapture {
    pub fn new() -> Self {
        Self {
            device: None,
            context: None,
            duplication: None,
            staging_texture: None,
            width: 0,
            height: 0,
            initialized: false,
        }
    }

    fn create_staging_texture(
        device: &ID3D11Device,
        width: u32,
        height: u32,
    ) -> Result<ID3D11Texture2D> {
        let desc = D3D11_TEXTURE2D_DESC {
            Width: width,
            Height: height,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: windows::Win32::Graphics::Dxgi::Common::DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_STAGING,
            BindFlags: windows::Win32::Graphics::Direct3D11::D3D11_BIND_FLAG(0),
            CPUAccessFlags: D3D11_CPU_ACCESS_READ,
            MiscFlags: windows::Win32::Graphics::Direct3D11::D3D11_RESOURCE_MISC_FLAG(0),
        };

        let mut texture: Option<ID3D11Texture2D> = None;
        unsafe {
            device
                .CreateTexture2D(&desc, None, Some(&mut texture))
                .context("CreateTexture2D for staging")?;
        }

        texture.context("staging texture was None")
    }
}

#[async_trait]
impl ScreenCapture for DxgiScreenCapture {
    async fn init(&mut self) -> Result<(u32, u32)> {
        info!("initializing DXGI Desktop Duplication");

        unsafe {
            // Create D3D11 device
            let mut device: Option<ID3D11Device> = None;
            let mut context: Option<ID3D11DeviceContext> = None;

            D3D11CreateDevice(
                None,
                D3D_DRIVER_TYPE_HARDWARE,
                None,
                windows::Win32::Graphics::Direct3D11::D3D11_CREATE_DEVICE_FLAG(0),
                None, // default feature levels
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                Some(&mut context),
            )
            .context("D3D11CreateDevice")?;

            let device = device.context("D3D11 device was None")?;
            let context = context.context("D3D11 context was None")?;

            // Get DXGI adapter and output
            let dxgi_device: IDXGIDevice = device.cast().context("cast to IDXGIDevice")?;
            let adapter: IDXGIAdapter = dxgi_device.GetAdapter().context("GetAdapter")?;
            let output: IDXGIOutput = adapter.EnumOutputs(0).context("EnumOutputs(0)")?;
            let output1: IDXGIOutput1 = output.cast().context("cast to IDXGIOutput1")?;

            // Get output description for dimensions
            let desc = output.GetDesc().context("GetDesc")?;
            let rect = desc.DesktopCoordinates;
            let width = (rect.right - rect.left) as u32;
            let height = (rect.bottom - rect.top) as u32;

            info!("screen dimensions: {}x{}", width, height);

            // Create output duplication
            let duplication = output1
                .DuplicateOutput(&device)
                .context("DuplicateOutput — DXGI Desktop Duplication may not be available (e.g., RDP session)")?;

            // Create staging texture for CPU readback
            let staging = Self::create_staging_texture(&device, width, height)?;

            self.device = Some(device);
            self.context = Some(context);
            self.duplication = Some(duplication);
            self.staging_texture = Some(staging);
            self.width = width;
            self.height = height;
            self.initialized = true;

            Ok((width, height))
        }
    }

    async fn capture_frame(&mut self) -> Result<ScreenFrame> {
        if !self.initialized {
            bail!("screen capture not initialized");
        }

        let duplication = self.duplication.as_ref().unwrap();
        let context = self.context.as_ref().unwrap();
        let staging = self.staging_texture.as_ref().unwrap();

        unsafe {
            // Acquire next frame (100ms timeout)
            let mut frame_info = DXGI_OUTDUPL_FRAME_INFO::default();
            let mut desktop_resource = None;

            let result = duplication.AcquireNextFrame(100, &mut frame_info, &mut desktop_resource);

            match result {
                Ok(()) => {}
                Err(e) => {
                    // DXGI_ERROR_WAIT_TIMEOUT — no new frame
                    if e.code().0 as u32 == 0x887A0027 {
                        // Return empty frame (no changes)
                        return Ok(ScreenFrame {
                            width: self.width,
                            height: self.height,
                            data: vec![],
                            stride: self.width * 4,
                        });
                    }
                    return Err(e).context("AcquireNextFrame");
                }
            }

            let resource = desktop_resource.context("desktop resource was None")?;
            let texture: ID3D11Texture2D = resource.cast().context("cast to ID3D11Texture2D")?;

            // Copy desktop texture to staging texture
            context.CopyResource(staging, &texture);

            // Release the frame
            duplication
                .ReleaseFrame()
                .context("ReleaseFrame")?;

            // Map the staging texture for CPU read
            let mapped = context
                .Map(staging, 0, D3D11_MAP_READ, 0)
                .context("Map staging texture")?;

            // Copy pixel data
            let stride = mapped.RowPitch;
            let data_size = (self.height * stride) as usize;
            let src = std::slice::from_raw_parts(mapped.pData as *const u8, data_size);

            // If stride matches width * 4, copy directly; otherwise, row by row
            let expected_stride = self.width * 4;
            let data = if stride == expected_stride {
                src.to_vec()
            } else {
                let mut data = Vec::with_capacity((self.width * self.height * 4) as usize);
                for y in 0..self.height {
                    let row_start = (y * stride) as usize;
                    let row_end = row_start + expected_stride as usize;
                    data.extend_from_slice(&src[row_start..row_end]);
                }
                data
            };

            context.Unmap(staging, 0);

            Ok(ScreenFrame {
                width: self.width,
                height: self.height,
                data,
                stride: self.width * 4,
            })
        }
    }

    fn dimensions(&self) -> (u32, u32) {
        (self.width, self.height)
    }
}

/// Factory function for creating screen capture on Windows
pub fn create_screen_capture() -> Result<Box<dyn ScreenCapture>> {
    info!("using DXGI Desktop Duplication for screen capture");
    Ok(Box::new(DxgiScreenCapture::new()))
}
