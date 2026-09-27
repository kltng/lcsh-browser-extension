import React, { useState, useRef, useEffect } from 'react';
import {
    Box,
    TextField,
    Button,
    Typography,
    Grid,
    Paper,
    Divider,
    Alert,
    CircularProgress,
    IconButton,
    Card,
    CardMedia,
    CardContent,
    CardActions
} from '@mui/material';
import { useAppContext } from '../context/AppContext';
import { describeActiveProvider } from '../services/pipeline/label';
import { onSettingsChanged } from '../services/settings';
import { createPreviewTracker } from './previewUrls';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import DeleteIcon from '@mui/icons-material/Delete';
import ImageIcon from '@mui/icons-material/Image';

const BibliographicInfoForm = () => {
    const {
        bibliographicInfo,
        setBibliographicInfo,
        systemPromptRules,
        setActiveStep,
        workflow,
        run,
        error,
        setError
    } = useAppContext();

    const isLoading = run.run.stage === 'suggesting';

    const [uploadedImages, setUploadedImages] = useState([]);
    const [providerLabel, setProviderLabel] = useState('');
    const fileInputRef = useRef(null);
    const previewsRef = useRef(null);
    if (!previewsRef.current) previewsRef.current = createPreviewTracker();

    // Revoke every outstanding preview URL when the form unmounts
    useEffect(() => () => previewsRef.current.revokeAll(), []);

    // Show which provider and model will be used; refresh when settings change
    useEffect(() => {
      let alive = true;
      const refresh = () => {
        describeActiveProvider()
          .then((label) => { if (alive) setProviderLabel(label); })
          .catch(() => { if (alive) setProviderLabel(''); });
      };
      refresh();
      const unsubscribe = onSettingsChanged(refresh);
      return () => {
        alive = false;
        unsubscribe();
      };
    }, []);

    // Handle form input changes
    const handleInputChange = (e) => {
        const { name, value } = e.target;
        setBibliographicInfo({
            ...bibliographicInfo,
            [name]: value
        });
    };

    // Handle file input change
    const handleFileChange = (e) => {
        const files = Array.from(e.target.files);

        // Filter for only image files (PNG and JPEG)
        const imageFiles = files.filter(file =>
            file.type === 'image/png' ||
            file.type === 'image/jpeg' ||
            file.type === 'image/jpg'
        );

        if (imageFiles.length !== files.length) {
            setError('Only PNG and JPEG images are allowed');
            return;
        }

        // Process each image file
        const newImages = imageFiles.map(file => ({
            file,
            preview: previewsRef.current.create(file),
            name: file.name,
            type: file.type,
            size: file.size
        }));

        setUploadedImages([...uploadedImages, ...newImages]);

        // Reset the file input
        e.target.value = null;
    };

    // Handle image delete
    const handleDeleteImage = (index) => {
        const newImages = [...uploadedImages];

        // Revoke the object URL to avoid memory leaks
        previewsRef.current.revoke(newImages[index].preview);

        newImages.splice(index, 1);
        setUploadedImages(newImages);
    };

    // Trigger file input click
    const handleUploadClick = () => {
        fileInputRef.current.click();
    };

    // Convert images to base64
    const convertImagesToBase64 = async () => {
        const base64Images = await Promise.all(
            uploadedImages.map(image =>
                new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve({
                        data: reader.result,
                        name: image.name,
                        type: image.type,
                        size: image.size
                    });
                    reader.onerror = reject;
                    reader.readAsDataURL(image.file);
                })
            )
        );

        return base64Images;
    };

    // Validate form
    const validateForm = () => {
        // At minimum, we need a title or at least one image
        if (!bibliographicInfo.title.trim() && uploadedImages.length === 0) {
            setError('Please provide a title or upload at least one image');
            return false;
        }

        // Clear any previous errors
        setError(null);
        return true;
    };

    // Handle form submission
    const handleSubmit = async (e) => {
        e.preventDefault();

        if (!validateForm()) {
            return;
        }

        // Convert images to base64 if any
        let imageData = [];
        try {
            if (uploadedImages.length > 0) {
                imageData = await convertImagesToBase64();
            }
        } catch (err) {
            setError('The images could not be read.');
            return;
        }

        // The context keeps image metadata only; the image data goes to this run
        setBibliographicInfo({
            ...bibliographicInfo,
            images: imageData.map(({ name, type, size }) => ({ name, type, size }))
        });

        // Step 1 of a NEW run; errors are kept in the run state and shown above the form
        await workflow.suggest({
            bibliographicInfo: { ...bibliographicInfo, images: imageData },
            rules: systemPromptRules
        });
        if (workflow.getState().run.stage === 'suggested') setActiveStep(1);
    };

    // Open the Settings screen
    const handleOpenSettings = () => {
        window.location.hash = 'settings';
    };

    return (
        <Box component="form" onSubmit={handleSubmit} noValidate>
            <Typography variant="h6" gutterBottom>
                Describe the work
            </Typography>

            {error && (
                <Alert severity="error" sx={{ mb: 2 }}>
                    {error}
                </Alert>
            )}

            {run.suggestError && !isLoading && (
                <Alert
                    severity="error"
                    sx={{ mb: 2 }}
                    action={(
                        <Box sx={{ display: 'flex', gap: 1 }}>
                            <Button color="inherit" size="small" type="submit">Retry</Button>
                            <Button color="inherit" size="small" onClick={handleOpenSettings}>Settings</Button>
                        </Box>
                    )}
                >
                    {run.suggestError.message}
                </Alert>
            )}

            <Grid container spacing={3}>
                <Grid item xs={12}>
                    <TextField
                        required={uploadedImages.length === 0}
                        fullWidth
                        label="Title"
                        name="title"
                        value={bibliographicInfo.title}
                        onChange={handleInputChange}
                        variant="outlined"
                        helperText={uploadedImages.length === 0 ? "Required (or upload an image)" : "Optional if image is uploaded"}
                    />
                </Grid>

                <Grid item xs={12}>
                    <TextField
                        fullWidth
                        label="Author"
                        name="author"
                        value={bibliographicInfo.author}
                        onChange={handleInputChange}
                        variant="outlined"
                    />
                </Grid>

                <Grid item xs={12}>
                    <TextField
                        fullWidth
                        label="Abstract"
                        name="abstract"
                        value={bibliographicInfo.abstract}
                        onChange={handleInputChange}
                        variant="outlined"
                        multiline
                        rows={4}
                        helperText="A brief summary of the work"
                    />
                </Grid>

                <Grid item xs={12}>
                    <TextField
                        fullWidth
                        label="Table of Contents"
                        name="tableOfContents"
                        value={bibliographicInfo.tableOfContents}
                        onChange={handleInputChange}
                        variant="outlined"
                        multiline
                        rows={4}
                        helperText="List of chapters or sections"
                    />
                </Grid>

                <Grid item xs={12}>
                    <TextField
                        fullWidth
                        label="Additional Notes"
                        name="notes"
                        value={bibliographicInfo.notes}
                        onChange={handleInputChange}
                        variant="outlined"
                        multiline
                        rows={4}
                        helperText="Any other relevant information"
                    />
                </Grid>

                <Grid item xs={12}>
                    <Box sx={{ mb: 2 }}>
                        <Typography variant="subtitle1" gutterBottom>
                            Upload Images (PNG, JPEG)
                        </Typography>
                        <Typography variant="body2" color="text.secondary" gutterBottom>
                            You can upload images of book covers, title pages, or other bibliographic information.
                        </Typography>

                        <input
                            type="file"
                            accept="image/png, image/jpeg, image/jpg"
                            style={{ display: 'none' }}
                            ref={fileInputRef}
                            onChange={handleFileChange}
                            multiple
                        />

                        <Button
                            variant="outlined"
                            startIcon={<CloudUploadIcon />}
                            onClick={handleUploadClick}
                            sx={{ mb: 2 }}
                        >
                            Upload Images
                        </Button>
                    </Box>

                    {uploadedImages.length > 0 && (
                        <Grid container spacing={2}>
                            {uploadedImages.map((image, index) => (
                                <Grid item xs={12} sm={6} md={4} key={index}>
                                    <Card>
                                        <CardMedia
                                            component="img"
                                            height="140"
                                            image={image.preview}
                                            alt={image.name}
                                            sx={{ objectFit: 'contain', bgcolor: '#f5f5f5' }}
                                        />
                                        <CardContent sx={{ py: 1 }}>
                                            <Typography variant="body2" noWrap>
                                                {image.name}
                                            </Typography>
                                            <Typography variant="caption" color="text.secondary">
                                                {(image.size / 1024).toFixed(1)} KB
                                            </Typography>
                                        </CardContent>
                                        <CardActions sx={{ justifyContent: 'flex-end', pt: 0 }}>
                                            <IconButton
                                                size="small"
                                                color="error"
                                                onClick={() => handleDeleteImage(index)}
                                            >
                                                <DeleteIcon fontSize="small" />
                                            </IconButton>
                                        </CardActions>
                                    </Card>
                                </Grid>
                            ))}
                        </Grid>
                    )}
                </Grid>
            </Grid>

            <Box sx={{ mt: 3, display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 2 }}>
                {providerLabel && (
                  <Typography variant="body2" color="text.secondary">
                    {providerLabel}
                  </Typography>
                )}
                <Button
                    type="submit"
                    variant="contained"
                    color="primary"
                    size="large"
                    disabled={isLoading}
                >
                    {isLoading ? (
                        <>
                            <CircularProgress size={24} sx={{ mr: 1 }} />
                            Suggesting headings...
                        </>
                    ) : (
                        'Suggest headings'
                    )}
                </Button>
            </Box>
        </Box>
    );
};

export default BibliographicInfoForm;
