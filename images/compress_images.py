import os
from PIL import Image

def compress_image(input_path, output_path, target_size_kb=5.0):
    target_size_bytes = target_size_kb * 1024
    
    # Open the image
    img = Image.open(input_path)
    
    # Convert RGBA/P to RGB if necessary for JPEG format
    if img.mode in ('RGBA', 'LA') or (img.mode == 'P' and 'transparency' in img.info):
        # Create a white background
        background = Image.new("RGB", img.size, (255, 255, 255))
        background.paste(img, mask=img.convert('RGBA').split()[3])
        img = background
    elif img.mode != 'RGB':
        img = img.convert('RGB')
        
    original_width, original_height = img.size
    print(f"\nProcessing {os.path.basename(input_path)}:")
    print(f"Original Dimensions: {original_width}x{original_height}")
    
    # Iterative compression loop
    quality = 85
    scale = 1.0
    
    while True:
        # Resize image based on current scale
        width = int(original_width * scale)
        height = int(original_height * scale)
        resized_img = img.resize((width, height), Image.Resampling.LANCZOS)
        
        # Save to a temporary file to check size
        resized_img.save(output_path, "JPEG", quality=quality)
        current_size = os.path.getsize(output_path)
        
        print(f"Scale: {scale:.2f}, Quality: {quality}, Result Size: {current_size / 1024:.2f} KB")
        
        if current_size < target_size_bytes:
            print(f"Successfully compressed to {current_size / 1024:.2f} KB!")
            break
            
        # If size is too large, reduce quality first, then scale
        if quality > 40:
            quality -= 5
        else:
            quality = 85
            scale -= 0.1
            
        if scale < 0.1:
            print("Error: Could not compress image below 5KB even at minimum dimensions.")
            break

# Source directory and files
images_dir = "/Users/rakeshkumarmallam/Rakesh-work/sre-bot/images"
image_1 = os.path.join(images_dir, "WhatsApp Image 2026-05-30 at 04.57.58 (1).jpeg")
image_2 = os.path.join(images_dir, "WhatsApp Image 2026-05-30 at 04.57.58.jpeg")

# Output files
out_1 = os.path.join(images_dir, "doctor_compressed.jpg")
out_2 = os.path.join(images_dir, "signature_compressed.jpg")

compress_image(image_1, out_1)
compress_image(image_2, out_2)
